#!/usr/bin/env node
// The conformance agent of conformance/README.md, written on the raw protocol with no SDK. The tests
// run it against the harness, and it shows an SDK's conformance agent what to do.
import fs from 'node:fs';
import WebSocket from 'ws';
import { audioFrame, connectPath, defaultPort, retainedFrames, rules, subprotocol } from './protocol.js';

/**
 * Connects to `url` and serves sessions until the harness closes the connection. `broken: 'echo'`
 * makes it answer echo wrongly, so the tests can check that the harness notices.
 */
export function startReferenceAgent({
  url,
  apiKey = 'conformance',
  agentId = 'agent_conformance',
  broken,
} = {}) {
  const sockets = new Set();
  // Each session by id: the connection it is on, its audio stream, its resume token, how many of Sent's
  // frames it has read, and its latest counted frames from number `base` on, to send again those Sent did not
  // read.
  const sessions = new Map();
  let stopped = false;

  const sessionsOn = (socket) => [...sessions.values()].filter((session) => session.socket === socket);

  // A session can move with its token, unless it is waiting for the answer to a resume: Sent may have used
  // that token.
  const movable = (session) => session.token && !session.resuming;

  // Opens a connection and, once Sent is ready on it, resumes the sessions in `moving` there.
  const connect = (moving = []) => {
    const address = new URL(url);
    address.searchParams.set('agent_id', agentId);
    const socket = new WebSocket(address, subprotocol, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    sockets.add(socket);
    // Whether Sent accepted the connection, and whether a new one took its place when it began draining.
    let opened = false;
    let replaced = false;
    socket.on('open', () => (opened = true));
    // A refused handshake surfaces as an error before close. The harness reports the refusal.
    socket.on('error', () => {});
    socket.on('close', () => {
      sockets.delete(socket);
      if (opened && !stopped) recover(socket, replaced);
    });
    socket.on('message', (data, isBinary) => {
      if (isBinary) return echoAudio(socket, Buffer.from(data));
      const frame = JSON.parse(data.toString());
      if (frame.type === 'connection.ready') {
        // A session that ended while the connection opened has nothing left to resume.
        for (const session of moving) if (sessions.get(session.id) === session) resume(session, socket);
        moving = [];
      }
      if (frame.type === 'connection.draining') {
        replaced = true;
        connect(sessionsOn(socket).filter(movable));
      }
      handle(socket, frame);
    });
  };

  // A lost connection's sessions resume on a new connection when they can move, and the others are given up.
  // The new connection also takes new calls, unless one already took the lost one's place when it drained.
  const recover = (socket, replaced) => {
    const lost = sessionsOn(socket);
    const resumable = lost.filter(movable);
    for (const session of lost) if (!resumable.includes(session)) sessions.delete(session.id);
    if (resumable.length || !replaced) connect(resumable);
  };

  // From here the session's frames on its old connection are ignored: Sent replays them on this one.
  const resume = (session, socket) => {
    session.socket = socket;
    session.resuming = true;
    send(socket, {
      type: 'session.resume',
      session_id: session.id,
      token: session.token,
      received: session.read,
    });
  };

  const send = (socket, frame) => socket.send(JSON.stringify(frame));

  // Sends a session's frame on the connection the session is on, and keeps the latest ones in case Sent does
  // not read them.
  const sendFor = (session, frame) => {
    if (session.sent.push(frame) > retainedFrames) {
      session.sent.shift();
      session.base++;
    }
    send(session.socket, frame);
  };

  // Audio sessions echo every frame back on the same stream.
  const echoAudio = (socket, frame) => {
    const { stream } = audioFrame.decode(frame);
    if (sessionsOn(socket).some((session) => session.stream === stream && !session.resuming))
      socket.send(frame);
  };

  const handle = (socket, frame) => {
    let session = sessions.get(frame.session_id);
    if (frame.session_id !== undefined && frame.type !== 'session.start') {
      // A session's frames count only on the connection it is on.
      if (session?.socket !== socket) return;
      // A frame type the agent does not know counts, as Compatibility in docs/protocol.md says.
      if (rules[frame.type]?.counted !== false) session.read++;
    }
    const say = (text, extra = {}) =>
      sendFor(session, { type: 'agent.say', session_id: session.id, text, ...extra });
    const tool = (name, args) =>
      sendFor(session, {
        type: 'tool.call',
        session_id: session.id,
        call_ref: `t${++session.calls}`,
        name,
        ...(args && { arguments: args }),
      });

    switch (frame.type) {
      case 'ping':
        return send(socket, { type: 'pong', ts: frame.ts });
      case 'session.start':
        session = {
          id: frame.session_id,
          socket,
          stream: frame.audio?.stream,
          token: frame.resume?.token,
          resuming: false,
          calls: 0,
          read: 0,
          base: 0,
          sent: [],
        };
        sessions.set(session.id, session);
        if (frame.session_type === 'text') say('Hello from the conformance agent.');
        return;
      case 'session.resumed': {
        session.resuming = false;
        session.token = frame.resume?.token;
        session.stream = frame.audio?.stream ?? session.stream;
        // Without a next token the session has ended, and only its replay is left.
        if (!session.token) return;
        // The count of frames sent goes back to received, and the frames after it go again, in order. A frame
        // Sent needs that is no longer kept ends the session.
        const short = frame.received < session.base;
        const unread = session.sent.slice(frame.received - session.base);
        session.base = frame.received;
        session.sent = [];
        if (short) return tool('hangup');
        for (const again of unread) sendFor(session, again);
        return;
      }
      case 'error':
        // A refused resume. This agent does not try another connection: it forgets the session.
        if (frame.frame_type === 'session.resume') sessions.delete(frame.session_id);
        return;
      case 'session.end':
        return sessions.delete(frame.session_id);
      case 'tool.result':
        if (!frame.ok) say(`Tool failed: ${frame.error.code}`);
        return;
      case 'user.said': {
        if (frame.correction) sendFor(session, { type: 'agent.clear', session_id: session.id });
        const [command, ...rest] = frame.text.split(' ');
        const argument = rest.join(' ');
        if (command === 'echo')
          return say(broken === 'echo' ? argument.split('').reverse().join('') : argument);
        if (command === 'stream') {
          say(rest[0], { last: false });
          return say(rest.slice(1).join(' '));
        }
        if (command === 'transfer')
          return tool('transfer', { to: { kind: 'user', value: 'conformance-desk' } });
        if (command === 'hangup') return tool('hangup');
        if (command === 'dtmf') return tool('send_dtmf', { digits: argument });
        if (command === 'hold') return tool('hold', { held: true });
        return;
      }
      default:
        // Frames it does not know are ignored, as the protocol requires.
        return;
    }
  };

  connect();
  return {
    // 1000 says the agent is done with its calls, so Sent ends them at once instead of holding them.
    stop: () => {
      stopped = true;
      sockets.forEach((socket) => socket.close(1000));
    },
  };
}

// Run by hand, or by the harness's --agent, which sets SENT_CONFORMANCE_URL.
// Node runs a module by its real path, so a symlinked argv[1] has to be resolved before comparing.
if (fs.realpathSync(process.argv[1]) === import.meta.filename) {
  startReferenceAgent({
    url: process.env.SENT_CONFORMANCE_URL ?? `ws://localhost:${defaultPort}${connectPath}`,
  });
}
