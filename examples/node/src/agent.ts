#!/usr/bin/env node
// A dial-in echo agent on the Sent Voice Agents protocol, written on the raw protocol with no SDK. It connects
// to Sent with the account API key, greets a text session and says back the caller's latest line, acts on a
// few spoken commands with the built-in tools, sends an audio session's audio back as it is, answers
// heartbeats, and keeps its sessions through a drain or a lost connection with session.resume.
// src/session.ts holds what happens inside one session. This file holds the connections.
import WebSocket from 'ws';
import { streamOf } from './audio.ts';
import { pong } from './frames.ts';
import type {
  AgentFrame,
  ConnectionReady,
  ErrorFrame,
  SentFrame,
  SessionEnd,
  SessionFrame,
  SessionResumed,
  SessionStart,
  ToolResult,
  UserSaid,
} from './frames.ts';
import { latestLine, Session } from './session.ts';

const SUBPROTOCOL = 'sent.voice.v1';
const DEFAULT_URL = 'wss://voice.sent.dm/v1/agents/connect';
/** The longest wait before another attempt to connect. */
const MAX_BACKOFF_MS = 30_000;
/** How long a handshake may take before the attempt counts as failed. */
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** Why Sent refuses a handshake with each status, from Connecting in docs/protocol.md. Each needs a person. */
const REFUSALS: Record<number, string> = {
  400: 'agent_id or the sent.voice.v1 subprotocol is missing',
  401: 'the API key is not valid',
  403: 'voice is not enabled for the account, or the key does not own the agent',
  404: 'the agent does not exist',
};

type Config = { apiKey: string; agentId: string; url: string; transferTo: string | undefined };

const log = (event: string, ...details: unknown[]): void =>
  console.log(new Date().toISOString(), event, ...details.filter((detail) => detail !== ''));

/** One WebSocket to Sent, and the sessions it reads and writes. */
class Connection {
  socket: WebSocket | undefined;
  /** Sent sent connection.ready, so the connection carries sessions. */
  ready = false;
  /** Sent sent connection.draining, so a new connection took this one's place for new calls. */
  draining = false;
  /** The sessions on this connection, by id. */
  readonly sessions = new Map<string, Session>();
  /** Sessions to resume here once Sent is ready. */
  pending: Session[];
  /** Sessions with a session.resume sent here that Sent has not answered yet. */
  readonly resuming = new Set<string>();
  /** The wait before dialling, then the watchdog for Sent's heartbeats. */
  timer: NodeJS.Timeout | undefined;
  heartbeatMs = 0;

  constructor(pending: Session[]) {
    this.pending = pending;
  }
}

class EchoAgent {
  private readonly config: Config;
  private readonly connections = new Set<Connection>();
  /** Every live session, by id. */
  private readonly sessions = new Map<string, Session>();
  private attempt = 0;
  private stopped = false;

  constructor(config: Config) {
    this.config = config;
  }

  start(): void {
    this.open([], 0);
  }

  /** Closes every connection with 1000: the agent is done with its calls, so they follow fallback at once. */
  stop(): void {
    this.stopped = true;
    for (const connection of this.connections) {
      clearTimeout(connection.timer);
      connection.socket?.close(1000);
    }
  }

  /** Opens a connection after `delay`, and resumes `pending` on it once Sent is ready. */
  private open(pending: Session[], delay: number): void {
    const connection = new Connection(pending);
    this.connections.add(connection);
    connection.timer = setTimeout(() => this.dial(connection), delay);
  }

  private dial(connection: Connection): void {
    const url = new URL(this.config.url);
    url.searchParams.set('agent_id', this.config.agentId);
    const socket = new WebSocket(url, SUBPROTOCOL, {
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    });
    connection.socket = socket;
    socket.on('open', () => log('connected', url.host));
    socket.on('unexpected-response', (request, response) => {
      const status = response.statusCode ?? 0;
      request.destroy();
      log('refused', status, REFUSALS[status] ?? 'trying again');
      if (status in REFUSALS) process.exit(1);
      this.closed(connection);
    });
    socket.on('error', (error) => log('socket error', error.message));
    socket.on('close', (code, reason) => {
      log('closed', code, reason.toString());
      this.closed(connection);
    });
    socket.on('message', (data, isBinary) => {
      this.heard(connection);
      if (isBinary) return this.echoAudio(connection, data as Buffer);
      let frame: SentFrame;
      try {
        frame = JSON.parse(data.toString()) as SentFrame;
      } catch {
        return log('not JSON', 'ignored');
      }
      this.handle(connection, frame);
    });
  }

  /** Resets the watchdog: no frame for three heartbeat intervals means the connection is dead. */
  private heard(connection: Connection): void {
    if (!connection.ready) return;
    clearTimeout(connection.timer);
    connection.timer = setTimeout(() => {
      log('silent', `no frame for ${3 * connection.heartbeatMs} ms, closing`);
      connection.socket?.terminate();
    }, 3 * connection.heartbeatMs);
  }

  private handle(connection: Connection, frame: SentFrame): void {
    switch (frame.type) {
      case 'connection.ready':
        return this.ready(connection, frame);
      case 'ping':
        return this.send(connection, pong(frame));
      case 'connection.draining':
        return this.drain(connection);
      case 'session.start':
        return this.startSession(connection, frame);
      case 'session.resumed':
        return this.resumed(connection, frame);
      case 'error':
        return this.failed(connection, frame);
      default:
        return this.read(connection, frame);
    }
  }

  private ready(connection: Connection, frame: ConnectionReady): void {
    connection.ready = true;
    connection.heartbeatMs = frame.heartbeat_interval_ms;
    this.attempt = 0;
    this.heard(connection);
    // A pending session may have ended, on its old connection, while this one opened.
    const pending = connection.pending.filter((session) => this.sessions.get(session.id) === session);
    connection.pending = [];
    log(
      'ready',
      `protocol ${frame.protocol_version}`,
      `up to ${frame.max_sessions} sessions`,
      pending.length ? `resuming ${pending.length}` : '',
    );
    for (const session of pending) this.resume(connection, session);
  }

  /**
   * Moves a session here. From now on it is read and written on this connection only: Sent replays here what
   * its old connection did not deliver, and drops what still reaches the old one.
   */
  private resume(connection: Connection, session: Session): void {
    for (const other of this.connections) other.sessions.delete(session.id);
    connection.sessions.set(session.id, session);
    connection.resuming.add(session.id);
    this.send(connection, session.resumeFrame());
    log('session.resume', session.id, `read ${session.received} of Sent's frames`);
  }

  private drain(connection: Connection): void {
    connection.draining = true;
    const moving = [...connection.sessions.values()].filter(
      (session) => session.token && !connection.resuming.has(session.id),
    );
    log('draining', moving.length ? `moving ${moving.length} session(s)` : 'no session to move');
    // The new connection takes new calls, and the sessions move once Sent is ready on it. Sent closes this
    // one with 1001 when no session is left on it.
    this.open(moving, 0);
  }

  private startSession(connection: Connection, frame: SessionStart): void {
    const session = new Session(frame, { transferTo: this.config.transferTo });
    this.sessions.set(session.id, session);
    connection.sessions.set(session.id, session);
    log(
      'session.start',
      session.id,
      frame.session_type,
      `${frame.direction} from ${frame.from.value ?? frame.from.kind}`,
      frame.resume ? `resumable for ${frame.resume.window_ms} ms` : 'not resumable',
      frame.audio ? `stream ${frame.audio.stream} at ${session.sampleRate} Hz` : '',
    );
    this.sendAll(connection, session.greeting());
  }

  private read(connection: Connection, frame: UserSaid | ToolResult | SessionEnd): void {
    const session = connection.sessions.get(frame.session_id);
    // A session that moved to another connection is read there: Sent replays what this one did not deliver.
    if (!session) return;
    const answers = session.read(frame);
    switch (frame.type) {
      case 'user.said':
        log(
          'user.said',
          session.id,
          JSON.stringify(latestLine(frame.text)),
          frame.correction ? 'correction' : '',
        );
        break;
      case 'tool.result':
        log(
          'tool.result',
          session.id,
          frame.call_ref,
          frame.ok ? 'ok' : `${frame.error?.code}: ${frame.error?.message}`,
        );
        break;
      case 'session.end':
        log(
          'session.end',
          session.id,
          frame.reason,
          `${frame.duration_ms} ms`,
          session.audioFrames ? `${session.audioFrames} audio frames sent back` : '',
        );
        break;
      default:
        // A frame type this sample does not know. It was counted, and that is all.
        log('frame', (frame as { type: string }).type, session.id, 'ignored');
    }
    this.sendAll(connection, answers);
    if (frame.type === 'session.end') this.forget(session);
  }

  private resumed(connection: Connection, frame: SessionResumed): void {
    const session = connection.sessions.get(frame.session_id);
    if (!session || !connection.resuming.delete(session.id)) return;
    const again = session.resumed(frame);
    log(
      'session.resumed',
      session.id,
      `Sent read ${frame.received} of the agent's frames`,
      frame.resume ? `sending ${again.length} again` : 'ended while detached, its replay follows',
      frame.audio ? `stream ${frame.audio.stream}` : '',
    );
    this.sendAll(connection, again);
  }

  private failed(connection: Connection, frame: ErrorFrame): void {
    log('error', frame.error.code, frame.error.message, frame.session_id ?? '', frame.frame_type ?? '');
    const id = frame.session_id;
    if (!id || !connection.resuming.has(id)) return;
    // The answer to a session.resume.
    const session = connection.sessions.get(id);
    connection.resuming.delete(id);
    connection.sessions.delete(id);
    if (!session) return;
    // This connection already carries max_sessions. The token is still good on another one.
    if (frame.error.code === 'connection_full') return this.open([session], 0);
    // resume_failed, or anything else: the session is over, as if it ended with agent_unreachable.
    this.forget(session);
  }

  /** Sends an audio session's frame back as it is, on the same stream. */
  private echoAudio(connection: Connection, frame: Buffer): void {
    if (frame.length < 2) return;
    const stream = streamOf(frame);
    for (const session of connection.sessions.values()) {
      if (session.stream !== stream || connection.resuming.has(session.id)) continue;
      if (session.audioFrames++ === 0)
        log('audio', session.id, `stream ${stream}`, `${frame.length - 2} bytes per frame`);
      return connection.socket?.send(frame);
    }
  }

  private forget(session: Session): void {
    this.sessions.delete(session.id);
    for (const connection of this.connections) connection.sessions.delete(session.id);
  }

  private closed(connection: Connection): void {
    // A refused handshake and the close that follows it both land here. The first one acts.
    if (!this.connections.delete(connection)) return;
    clearTimeout(connection.timer);
    if (this.stopped) return;
    const queued = (session: Session) =>
      [...this.connections].some((other) => other.pending.includes(session));
    const lost = [...connection.sessions.values()];
    // A session moves with its token, unless its resume is waiting for an answer: Sent may have spent it.
    const movable = lost.filter(
      (session) => session.token && !connection.resuming.has(session.id) && !queued(session),
    );
    for (const session of lost) {
      if (movable.includes(session) || queued(session)) continue;
      log(
        'session lost',
        session.id,
        session.token ? 'its resume was not answered' : 'it has no resume token',
      );
      this.forget(session);
    }
    // Sessions this connection never got to resume are still waiting, within their window.
    const pending = [
      ...connection.pending.filter((session) => this.sessions.get(session.id) === session),
      ...movable,
    ];
    if (connection.draining && !pending.length) return;
    const delay = this.backoff();
    log(
      'reconnecting',
      `in ${delay} ms`,
      pending.length ? `to resume ${pending.map((s) => s.id).join(', ')}` : '',
    );
    this.open(pending, delay);
  }

  /** At once the first time, then 1, 2, 4 seconds and so on, up to MAX_BACKOFF_MS. Reset by connection.ready. */
  private backoff(): number {
    const delay = this.attempt === 0 ? 0 : Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (this.attempt - 1));
    this.attempt++;
    return delay;
  }

  private send(connection: Connection, frame: AgentFrame): void {
    if (connection.socket?.readyState === WebSocket.OPEN)
      return connection.socket.send(JSON.stringify(frame));
    // A session frame is still counted as sent. Sent's received on the next resume says to send it again.
    log('not sent', frame.type, 'the connection is not open');
  }

  private sendAll(connection: Connection, frames: SessionFrame[]): void {
    for (const frame of frames) this.send(connection, frame);
  }
}

const env = (name: string): string | undefined => process.env[name] || undefined;
const required = (name: string): string => {
  const value = env(name);
  if (value) return value;
  console.error(`${name} is not set`);
  process.exit(1);
};

const transferTo = env('TRANSFER_TO');
if (transferTo && !/^\+[1-9][0-9]{6,14}$/.test(transferTo)) {
  console.error('TRANSFER_TO must be an E.164 number, such as +14155550123');
  process.exit(1);
}

const agent = new EchoAgent({
  apiKey: required('SENT_API_KEY'),
  agentId: required('SENT_AGENT_ID'),
  url: env('SENT_VOICE_URL') ?? DEFAULT_URL,
  transferTo,
});
agent.start();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log('stopping', signal);
    agent.stop();
  });
}
