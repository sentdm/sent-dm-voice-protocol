import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { loadScenarios, startHarness } from '../conformance/harness.js';
import { agentFrameErrors } from '../conformance/protocol.js';
import { startReferenceAgent } from '../conformance/reference-agent.js';

const run = async (agentOptions = {}, harnessOptions = {}) => {
  const harness = await startHarness({ port: 0, timeoutMs: 1000, settleMs: 50, ...harnessOptions });
  const agent = startReferenceAgent({ url: harness.url, ...agentOptions });
  try {
    return await harness.results;
  } finally {
    agent.stop();
  }
};

describe('the conformance harness', () => {
  test('passes the reference agent on every scenario', async () => {
    const outcomes = await run();
    assert.deepEqual(
      outcomes.filter(({ ok }) => !ok),
      [],
    );
    assert.equal(outcomes.length, loadScenarios().length);
  });

  test('fails an agent that answers wrongly, and names the step', async () => {
    const outcomes = await run({ broken: 'echo' }, { scenarios: loadScenarios(['01-greeting-and-echo']) });

    assert.equal(outcomes[0].ok, false);
    assert.match(outcomes[0].reason, /^step 4: expected .*"text":"banana"/);
  });

  test('refuses a connection without a bearer token', async () => {
    const outcomes = await run(
      { apiKey: '' },
      { scenarios: loadScenarios(['09-heartbeat']), connectTimeoutMs: 500 },
    );

    assert.deepEqual(outcomes, [
      {
        name: 'connect',
        ok: false,
        reason: "the harness refused the agent's connection: 401 no bearer token",
      },
    ]);
  });
});

describe('the rules an agent frame must keep', () => {
  const sessions = new Map([
    ['vs_text', 'text'],
    ['vs_audio', 'audio'],
  ]);
  const say = (session_id) => ({ type: 'agent.say', session_id, text: 'Hi' });

  test('let an agent say text in an open text session, and answer a ping', () => {
    assert.equal(agentFrameErrors(say('vs_text'), sessions), undefined);
    assert.equal(agentFrameErrors({ type: 'pong', ts: 1 }, sessions), undefined);
  });

  test('refuse a frame only Sent sends', () => {
    assert.equal(agentFrameErrors({ type: 'ping', ts: 1 }, sessions), 'ping, which only Sent sends');
  });

  test('refuse a frame for a session that is not open', () => {
    assert.equal(
      agentFrameErrors(say('vs_gone'), sessions),
      'agent.say for vs_gone, which is not an open session',
    );
  });

  test('refuse a frame in a session type it is not for', () => {
    assert.equal(
      agentFrameErrors(say('vs_audio'), sessions),
      'agent.say in audio session vs_audio, and agent.say is for text sessions only',
    );
  });
});
