import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { audioFrame, samplesOf, streamOf } from '../src/audio.ts';
import type { SessionFrame, SessionStart, UserSaid } from '../src/frames.ts';
import { GREETING, RETAINED_FRAMES, Session, latestLine } from '../src/session.ts';

const id = 'vs_7Hq2Lm9xQa';
const token = 'vsr_9fK2mQ7xLp4ZbT8wNc3RjV6hYd';
const next = 'vsr_Hn5tW1qGz8kXc4PmR7vB2sLf0J';
const start = (overrides: Partial<SessionStart> = {}): SessionStart => ({
  type: 'session.start',
  session_id: id,
  call_id: 'call_01JBX6Y3R0QK5D8M2T4W6Z9C1E',
  agent_id: 'agent_01JBX6Y3NHZ9V3K7T2Q5R8M4PA',
  direction: 'inbound',
  from: { kind: 'number', value: '+14155550100' },
  to: { kind: 'number', value: '+14155550199' },
  session_type: 'text',
  started_at: '2026-10-23T12:00:00Z',
  resume: { token, window_ms: 15000 },
  ...overrides,
});
const said = (text: string, correction = false): UserSaid => ({
  type: 'user.said',
  session_id: id,
  text,
  ...(correction && { correction }),
});
const texts = (frames: SessionFrame[]) =>
  frames.map((frame) => (frame.type === 'agent.say' ? frame.text : frame.type));

describe('counting', () => {
  test("counts each of Sent's frames for the session, except the ones marked x-sent-counted: false", () => {
    const session = new Session(start());
    assert.equal(session.received, 0);
    session.read(said('one'));
    session.read({ type: 'tool.result', session_id: id, call_ref: 't1', ok: true });
    assert.equal(session.received, 2);
    session.read({ type: 'error', session_id: id });
    session.read({ type: 'session.resumed', session_id: id });
    assert.equal(session.received, 2, 'error and session.resumed do not count');
    session.read({ type: 'user.waited', session_id: id });
    assert.equal(session.received, 3, 'a frame type the sample does not know counts');
    session.read({ type: 'session.end', session_id: id });
    assert.equal(session.received, 4);
  });

  test("counts the agent's frames, and goes back to what Sent read on a resume", () => {
    const session = new Session(start());
    session.greeting();
    session.read(said('one'));
    session.read(said('two'));
    assert.equal(session.sent, 3);
    const again = session.resumed({
      type: 'session.resumed',
      session_id: id,
      received: 1,
      resume: { token: next, window_ms: 15000 },
    });
    assert.deepEqual(texts(again), ['one', 'two'], 'the frames Sent did not read go again, in order');
    assert.equal(session.sent, 3);
  });
});

describe('the resume payload', () => {
  test("carries the latest token and how many of Sent's frames were read", () => {
    const session = new Session(start());
    session.read(said('one'));
    assert.deepEqual(session.resumeFrame(), { type: 'session.resume', session_id: id, token, received: 1 });
    session.resumed({
      type: 'session.resumed',
      session_id: id,
      received: 2,
      resume: { token: next, window_ms: 15000 },
    });
    session.read(said('two'));
    assert.deepEqual(session.resumeFrame(), {
      type: 'session.resume',
      session_id: id,
      token: next,
      received: 2,
    });
  });

  test('does not exist for a session without a token', () => {
    const session = new Session(start({ resume: undefined }));
    assert.equal(session.token, undefined);
    assert.throws(() => session.resumeFrame());
  });
});

describe('session.resumed', () => {
  test('hangs up when Sent needs a frame the session no longer keeps', () => {
    const session = new Session(start());
    for (let line = 0; line <= RETAINED_FRAMES; line++) session.read(said(`line ${line}`));
    assert.equal(session.sent, RETAINED_FRAMES + 1);
    const again = session.resumed({
      type: 'session.resumed',
      session_id: id,
      received: 0,
      resume: { token: next, window_ms: 15000 },
    });
    assert.equal(again.length, 1);
    assert.equal(again[0]?.type, 'tool.call');
    assert.equal((again[0] as { name: string }).name, 'hangup');
  });

  test('sends nothing more when the session ended while it was detached', () => {
    const session = new Session(start());
    session.read(said('one'));
    assert.deepEqual(session.resumed({ type: 'session.resumed', session_id: id, received: 0 }), []);
    assert.equal(session.token, undefined);
  });

  test('takes the stream the audio session has on the new connection', () => {
    const session = new Session(start({ session_type: 'audio', audio: { stream: 7, sample_rate: 24000 } }));
    assert.equal(session.stream, 7);
    assert.equal(session.sampleRate, 24000);
    session.resumed({
      type: 'session.resumed',
      session_id: id,
      received: 0,
      resume: { token: next, window_ms: 15000 },
      audio: { stream: 3 },
    });
    assert.equal(session.stream, 3);
  });
});

describe('what the caller hears', () => {
  test('a greeting in a text session, nothing in an audio session', () => {
    assert.deepEqual(texts(new Session(start()).greeting()), [GREETING]);
    assert.deepEqual(new Session(start({ session_type: 'audio', audio: { stream: 1 } })).greeting(), []);
  });

  test('the latest line said back', () => {
    const session = new Session(start());
    assert.deepEqual(texts(session.read(said('Hello there'))), ['Hello there']);
    assert.deepEqual(texts(session.read(said('Hello there\nAnd again.', true))), [
      'agent.clear',
      'And again.',
    ]);
    assert.equal(latestLine('  one \n\n two  \n'), 'two');
  });

  test('a tool for each command, however it is said', () => {
    const session = new Session(start(), { transferTo: '+14155550123' });
    const tools = (frames: SessionFrame[]) =>
      frames.flatMap((frame) =>
        frame.type === 'tool.call' ? [{ name: frame.name, arguments: frame.arguments }] : [],
      );
    assert.deepEqual(tools(session.read(said('Transfer.'))), [
      { name: 'transfer', arguments: { to: { kind: 'number', value: '+14155550123' } } },
    ]);
    assert.deepEqual(tools(session.read(said('hold'))), [{ name: 'hold', arguments: { held: true } }]);
    assert.deepEqual(tools(session.read(said('Resume!'))), [{ name: 'hold', arguments: { held: false } }]);
    assert.deepEqual(tools(session.read(said('Hang up'))), [{ name: 'hangup', arguments: undefined }]);
    assert.deepEqual(tools(session.read(said('goodbye'))), [{ name: 'hangup', arguments: undefined }]);
    assert.deepEqual(tools(session.read(said('hold the line'))), [], 'an echo, not a command');
  });

  test('the transfer command without a target is refused in speech', () => {
    assert.deepEqual(texts(new Session(start()).read(said('transfer'))), ['No transfer target is set.']);
  });
});

describe('an audio frame', () => {
  test('starts with the stream, big-endian, then the samples', () => {
    const samples = Buffer.from([0x01, 0x00, 0xff, 0x7f]);
    const frame = audioFrame(7, samples);
    assert.deepEqual([...frame], [0x00, 0x07, 0x01, 0x00, 0xff, 0x7f]);
    assert.equal(streamOf(frame), 7);
    assert.deepEqual(samplesOf(frame), samples);
  });
});
