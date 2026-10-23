#!/usr/bin/env node
// Plays Sent's side of the protocol against an agent: it accepts the agent's connection the way
// wss://voice.sent.dm does, then runs every scenario in conformance/scenarios and checks each frame
// the agent sends. See conformance/README.md for what the agent under test must do.
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { WebSocketServer } from 'ws';
import {
  agentFrameErrors,
  audioFrame,
  connectPath,
  defaultPort,
  readJson,
  root,
  subprotocol,
  version,
} from './protocol.js';

/** The scenarios in conformance/scenarios, in file order, optionally only the named ones. */
export function loadScenarios(only = []) {
  return fs
    .readdirSync(path.join(root, 'conformance/scenarios'))
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => ({ name: file.replace(/\.json$/, ''), ...readJson(`conformance/scenarios/${file}`) }))
    .filter(({ name }) => only.length === 0 || only.includes(name));
}

/** Items in arrival order, and a way to wait for the next one. */
class Inbox {
  #items = [];
  #events = new EventEmitter();
  #closed = false;

  push(item) {
    this.#items.push(item);
    this.#events.emit('change');
  }

  close() {
    this.#closed = true;
    this.#events.emit('change');
  }

  /** The next item, waiting up to timeoutMs. Undefined when none came, or the inbox closed empty. */
  async next(timeoutMs) {
    if (!this.#items.length && !this.#closed) {
      await once(this.#events, 'change', { signal: AbortSignal.timeout(timeoutMs) }).catch(() => {});
    }
    return this.#items.shift();
  }

  drain() {
    return this.#items.splice(0);
  }
}

// What the agent sends is sorted into one inbox per session, one per audio stream, and one for the
// connection. Each session's frames must keep their order, but two sessions' frames may interleave.
const inboxOf = (item) =>
  item.audio ? `stream ${item.audio.stream}`
  : typeof item.frame?.session_id === 'string' ? item.frame.session_id
  : 'connection';

class Connection {
  #inboxes = new Map();
  #pings = new Map();
  #lastPing = 0;
  /** The close code, once the connection has closed. */
  closed;

  constructor(socket) {
    this.socket = socket;
    socket.on('message', (data, isBinary) => {
      const item = isBinary ? { audio: audioFrame.decode(Buffer.from(data)) } : parse(data.toString());
      if (item.frame?.type === 'pong' && this.#pings.has(item.frame.ts))
        return this.#pings.get(item.frame.ts)();
      this.#inbox(inboxOf(item)).push(item);
    });
    socket.on('close', (code) => {
      this.closed = code;
      for (const inbox of this.#inboxes.values()) inbox.close();
    });
  }

  #inbox(key) {
    if (!this.#inboxes.has(key)) {
      this.#inboxes.set(key, new Inbox());
      if (this.closed !== undefined) this.#inboxes.get(key).close();
    }
    return this.#inboxes.get(key);
  }

  send(frame) {
    this.socket.send(JSON.stringify(frame));
  }

  sendAudio(stream, samples) {
    this.socket.send(audioFrame.encode(stream, samples));
  }

  /** The next item for a session id, `stream <n>` or `connection`, waiting up to timeoutMs. */
  next(key, timeoutMs) {
    return this.#inbox(key).next(timeoutMs);
  }

  /** Whatever the agent sent that no step read. */
  drain() {
    return [...this.#inboxes.values()].flatMap((inbox) => inbox.drain());
  }

  /** Pings, then waits up to timeoutMs for the pong, so that whatever the agent sent before it has arrived. */
  async settle(timeoutMs) {
    if (this.closed !== undefined) return;
    const ts = (this.#lastPing = Math.max(Date.now(), this.#lastPing + 1));
    const pong = new Promise((resolve) => this.#pings.set(ts, resolve));
    this.send({ type: 'ping', ts });
    await Promise.race([pong, sleep(timeoutMs, undefined, { ref: false })]);
  }
}

const parse = (text) => {
  try {
    return { frame: JSON.parse(text) };
  } catch {
    return { invalid: text };
  }
};

const describe = (item) =>
  item.audio ? `audio on stream ${item.audio.stream}`
  : item.invalid !== undefined ? `text that is not JSON: ${item.invalid.slice(0, 80)}`
  : JSON.stringify(item.frame);

// What a step got when it waited for something that did not come.
function nothing(connection) {
  if (connection.closed !== undefined)
    return `nothing: the agent closed the connection with ${connection.closed}`;
  const others = connection.drain();
  return others.length ? `nothing, but the agent sent ${others.map(describe).join(', ')}` : 'nothing';
}

// A frame matches when every field the step names has that value. Nested objects match the same way, so a
// step names only the fields it checks. Fields the agent left out already hold their schema defaults.
const matches = (expected, actual) =>
  expected && typeof expected === 'object' && !Array.isArray(expected) ?
    Boolean(actual) &&
    typeof actual === 'object' &&
    Object.entries(expected).every(([key, value]) => matches(value, actual[key]))
  : isDeepStrictEqual(expected, actual);

// "$a" and "$b" name the scenario's sessions; any other "$name" is a value captured earlier.
function substitute(value, names) {
  if (typeof value === 'string' && value.startsWith('$') && value.slice(1) in names)
    return names[value.slice(1)];
  if (Array.isArray(value)) return value.map((v) => substitute(v, names));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, names)]));
  }
  return value;
}

// 16-bit little-endian samples counting up from a seed, so an echo can be told from silence.
const samplesFor = (count, seed) => {
  const samples = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) samples.writeInt16LE((seed + i) % 32768, i * 2);
  return samples;
};

// Why Sent would refuse this handshake, as [status, reason], or undefined when it would accept it.
function refusalOf(req) {
  if (!/^Bearer \S+/.test(req.headers.authorization ?? '')) return [401, 'no bearer token'];
  if (!new URL(req.url, 'ws://localhost').searchParams.get('agent_id')) return [400, 'no agent_id'];
  const offered = (req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim());
  if (!offered.includes(subprotocol)) return [400, `no ${subprotocol} subprotocol`];
  return undefined;
}

async function runScenario(scenario, index, run) {
  const names = { a: `vs_conf${index}a`, b: `vs_conf${index}b` };
  const sentAudio = {};

  for (const [number, step] of scenario.steps.entries()) {
    const fail = (reason) => {
      throw new Error(`step ${number + 1}: ${reason}`);
    };

    if (step.send) {
      const frame = substitute(step.send, names);
      if (frame.type === 'session.start') run.sessions.set(frame.session_id, frame.session_type);
      if (frame.type === 'session.end') run.sessions.delete(frame.session_id);
      run.connection.send(frame);
    } else if (step.send_audio) {
      const { stream, samples } = step.send_audio;
      sentAudio[stream] = samplesFor(samples, number * 1000);
      run.connection.sendAudio(stream, sentAudio[stream]);
    } else if (step.expect) {
      const expected = substitute(step.expect, names);
      const item = await run.connection.next(expected.session_id ?? 'connection', run.timeoutMs);
      if (!item) fail(`expected ${JSON.stringify(expected)}, got ${nothing(run.connection)}`);
      if (!item.frame) fail(`expected ${JSON.stringify(expected)}, got ${describe(item)}`);
      const errors = agentFrameErrors(item.frame, run.sessions);
      if (errors) fail(`the agent sent ${errors}`);
      if (!matches(expected, item.frame)) {
        fail(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(item.frame)}`);
      }
      for (const [name, field] of Object.entries(step.capture ?? {})) names[name] = item.frame[field];
    } else if (step.expect_audio) {
      const { stream } = step.expect_audio;
      const item = await run.connection.next(`stream ${stream}`, run.timeoutMs);
      if (!item) fail(`expected audio on stream ${stream}, got ${nothing(run.connection)}`);
      if (!item.audio.samples.equals(sentAudio[stream]))
        fail('the audio that came back is not the audio that was sent');
    } else if (step.expect_reconnect) {
      const next = await run.pending.next(run.timeoutMs);
      if (!next?.connection)
        fail(next?.failure ?? 'the agent did not open a new connection after connection.draining');
      run.connection = next.connection;
    } else {
      fail(`unknown step ${JSON.stringify(step)}`);
    }
  }

  // A frame the agent sends before answering the ping fails this scenario rather than the next one.
  await run.connection.settle(run.settleMs);
  const leftover = run.connection.drain();
  if (leftover.length) throw new Error(`the agent also sent ${leftover.map(describe).join(', ')}`);
}

/**
 * Listens like wss://voice.sent.dm, then runs the scenarios against the first agent that connects.
 * Resolves with where to connect and a promise of the results.
 */
export async function startHarness({
  port = defaultPort,
  scenarios = loadScenarios(),
  timeoutMs = 3000,
  connectTimeoutMs = 30000,
  settleMs = 200,
} = {}) {
  // Each connection the agent opens, or why the harness refused one.
  const pending = new Inbox();
  const server = new WebSocketServer({
    port,
    path: connectPath,
    handleProtocols: () => subprotocol,
    verifyClient: ({ req }, done) => {
      const refusal = refusalOf(req);
      if (!refusal) return done(true);
      pending.push({ failure: `the harness refused the agent's connection: ${refusal.join(' ')}` });
      return done(false, ...refusal);
    },
  });
  server.on('connection', (socket) => {
    const connection = new Connection(socket);
    connection.send({
      type: 'connection.ready',
      protocol_version: version,
      heartbeat_interval_ms: 60000,
      max_sessions: 10,
    });
    pending.push({ connection });
  });
  await once(server, 'listening');

  const results = (async () => {
    const first = await pending.next(connectTimeoutMs);
    if (!first?.connection) {
      server.close();
      return [{ name: 'connect', ok: false, reason: first?.failure ?? 'no agent connected' }];
    }
    const run = { connection: first.connection, pending, sessions: new Map(), timeoutMs, settleMs };
    const outcomes = [];
    for (const [index, scenario] of scenarios.entries()) {
      try {
        await runScenario(scenario, String(index + 1).padStart(2, '0'), run);
        outcomes.push({ name: scenario.name, ok: true });
      } catch (error) {
        outcomes.push({ name: scenario.name, ok: false, reason: error.message });
        await run.connection.settle(settleMs);
        run.connection.drain();
      }
    }
    // Not waiting for the agent's close frame, which an agent that hangs would never send.
    for (const client of server.clients) client.close(1001);
    server.close();
    return outcomes;
  })();

  return { url: `ws://localhost:${server.address().port}${connectPath}`, results };
}

// Node runs a module by its real path, so a symlinked argv[1] has to be resolved before comparing.
if (fs.realpathSync(process.argv[1]) === import.meta.filename) {
  const { values } = parseArgs({
    options: {
      port: { type: 'string' },
      only: { type: 'string', multiple: true, default: [] },
      timeout: { type: 'string' },
      agent: { type: 'string' },
    },
  });
  const harness = await startHarness({
    // With --agent, the agent learns the URL from the environment, so any free port will do.
    port: Number(values.port ?? (values.agent ? 0 : defaultPort)),
    scenarios: loadScenarios(values.only),
    timeoutMs: values.timeout && Number(values.timeout),
  });
  console.log(`Waiting for an agent at ${harness.url}`);
  // The agent runs in a process group of its own, so stopping it also stops whatever its command started.
  const agent =
    values.agent &&
    spawn(values.agent, {
      shell: true,
      stdio: 'inherit',
      detached: true,
      env: { ...process.env, SENT_CONFORMANCE_URL: harness.url },
    });
  const outcomes = await harness.results;
  try {
    if (agent) process.kill(-agent.pid);
  } catch {
    // The agent has already exited.
  }
  for (const [index, { name, ok, reason }] of outcomes.entries()) {
    console.log(`${ok ? 'ok' : 'not ok'} ${index + 1} - ${name}${ok ? '' : `\n  # ${reason}`}`);
  }
  const failed = outcomes.filter(({ ok }) => !ok).length;
  console.log(`# ${outcomes.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
