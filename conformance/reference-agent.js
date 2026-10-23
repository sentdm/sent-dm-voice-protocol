#!/usr/bin/env node
// The conformance agent of conformance/README.md, written on the raw protocol with no SDK. The tests
// run it against the harness, and it shows an SDK's conformance agent what to do.
import fs from 'node:fs';
import WebSocket from 'ws';
import { audioFrame, connectPath, defaultPort, subprotocol } from './protocol.js';

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
  const sessions = new Map();

  const connect = () => {
    const address = new URL(url);
    address.searchParams.set('agent_id', agentId);
    const socket = new WebSocket(address, subprotocol, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    sockets.add(socket);
    // A refused handshake surfaces as an error before close. The harness reports the refusal.
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.on('message', (data, isBinary) => {
      if (isBinary) return echoAudio(socket, Buffer.from(data));
      handle(socket, JSON.parse(data.toString()));
    });
  };

  const send = (socket, frame) => socket.send(JSON.stringify(frame));

  // Audio sessions echo every frame back on the same stream.
  const echoAudio = (socket, frame) => {
    const { stream } = audioFrame.decode(frame);
    if ([...sessions.values()].some((session) => session.stream === stream)) socket.send(frame);
  };

  const handle = (socket, frame) => {
    const say = (text, extra = {}) =>
      send(socket, { type: 'agent.say', session_id: frame.session_id, text, ...extra });
    const tool = (name, args) =>
      send(socket, {
        type: 'tool.call',
        session_id: frame.session_id,
        call_ref: `t${++sessions.get(frame.session_id).calls}`,
        name,
        ...(args && { arguments: args }),
      });

    switch (frame.type) {
      case 'ping':
        return send(socket, { type: 'pong', ts: frame.ts });
      case 'connection.draining':
        return connect();
      case 'session.start':
        sessions.set(frame.session_id, { calls: 0, stream: frame.audio?.stream });
        if (frame.session_type === 'text') say('Hello from the conformance agent.');
        return;
      case 'session.end':
        return sessions.delete(frame.session_id);
      case 'tool.result':
        if (!frame.ok) say(`Tool failed: ${frame.error.code}`);
        return;
      case 'user.said': {
        if (frame.correction) send(socket, { type: 'agent.clear', session_id: frame.session_id });
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
  return { stop: () => sockets.forEach((socket) => socket.close()) };
}

// Run by hand, or by the harness's --agent, which sets SENT_CONFORMANCE_URL.
// Node runs a module by its real path, so a symlinked argv[1] has to be resolved before comparing.
if (fs.realpathSync(process.argv[1]) === import.meta.filename) {
  startReferenceAgent({
    url: process.env.SENT_CONFORMANCE_URL ?? `ws://localhost:${defaultPort}${connectPath}`,
  });
}
