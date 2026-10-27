// Every frame the sample can send is valid against the protocol's schemas, three directories up, checked with
// the validator the repository's own tests use.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { Ajv, type ValidateFunction } from 'ajv';
// ajv-formats is a CommonJS module, so under Node's ESM rules its default import is the module itself.
import formats from 'ajv-formats';
import { pong } from '../src/frames.ts';
import type { AgentFrame, SessionStart, UserSaid } from '../src/frames.ts';
import { RETAINED_FRAMES, Session } from '../src/session.ts';

const schemas = path.resolve(import.meta.dirname, '../../../schemas');
const read = (file: string) => JSON.parse(fs.readFileSync(path.join(schemas, file), 'utf8'));

const ajv = new Ajv({ allErrors: true, strictTypes: true });
formats.default(ajv);
ajv.addSchema(read('common.json'));
const validators = new Map<string, ValidateFunction>();
const validator = (type: string): ValidateFunction => {
  const compiled = validators.get(type) ?? ajv.compile(read(`frames/${type}.json`));
  validators.set(type, compiled);
  return compiled;
};

const id = 'vs_7Hq2Lm9xQa';
const resume = { token: 'vsr_9fK2mQ7xLp4ZbT8wNc3RjV6hYd', window_ms: 15000 };
const start: SessionStart = {
  type: 'session.start',
  session_id: id,
  call_id: 'call_01JBX6Y3R0QK5D8M2T4W6Z9C1E',
  agent_id: 'agent_01JBX6Y3NHZ9V3K7T2Q5R8M4PA',
  direction: 'inbound',
  from: { kind: 'number', value: '+14155550100' },
  to: { kind: 'number', value: '+14155550199' },
  session_type: 'text',
  started_at: '2026-10-23T12:00:00Z',
  resume,
};
const said = (text: string, correction = false): UserSaid => ({
  type: 'user.said',
  session_id: id,
  text,
  ...(correction && { correction }),
});

/** Everything the sample sends over one scripted call, each frame with what brought it about. */
function everyFrame(): { origin: string; frame: AgentFrame }[] {
  const frames: { origin: string; frame: AgentFrame }[] = [];
  const add = (origin: string, ...list: AgentFrame[]) =>
    frames.push(...list.map((frame) => ({ origin, frame })));
  const session = new Session(start, { transferTo: '+14155550123' });
  add('ping', pong({ type: 'ping', ts: 1792411215000 }));
  add('session.start', ...session.greeting());
  add('an utterance', ...session.read(said('Hello there')));
  add('a correction', ...session.read(said('Hello there\nHello there, Sent.', true)));
  add('transfer', ...session.read(said('Transfer.')));
  add('hold', ...session.read(said('Hold')));
  add('resume', ...session.read(said('resume')));
  add('a lost connection', session.resumeFrame());
  add(
    'session.resumed',
    ...session.resumed({ type: 'session.resumed', session_id: id, received: 2, resume }),
  );
  add('goodbye', ...session.read(said('Goodbye!')));
  const bare = new Session(start);
  add('transfer without a target', ...bare.read(said('transfer')));
  for (let line = 0; line <= RETAINED_FRAMES; line++) bare.read(said(`line ${line}`));
  add(
    'a frame no longer kept',
    ...bare.resumed({ type: 'session.resumed', session_id: id, received: 0, resume }),
  );
  return frames;
}

describe('every frame the sample sends', () => {
  const frames = everyFrame();

  for (const { origin, frame } of frames) {
    test(`${frame.type} after ${origin} is valid`, () => {
      const validate = validator(frame.type);
      assert.ok(validate(frame), ajv.errorsText(validate.errors));
    });
  }

  test('cover every frame type and tool the sample uses', () => {
    const types = new Set(frames.map(({ frame }) => frame.type));
    assert.deepEqual([...types].sort(), ['agent.clear', 'agent.say', 'pong', 'session.resume', 'tool.call']);
    const tools = new Set(frames.flatMap(({ frame }) => (frame.type === 'tool.call' ? [frame.name] : [])));
    assert.deepEqual([...tools].sort(), ['hangup', 'hold', 'transfer']);
  });
});
