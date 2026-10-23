import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import {
  ajv,
  diagnostics,
  frameTypes as frames,
  readJson,
  root,
  rules,
  schemas,
  spec as document,
  validators,
  version,
} from '../conformance/protocol.js';

const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const list = (dir) => fs.readdirSync(path.join(root, dir)).sort();

const examples = (kind) =>
  list(`examples/${kind}`).flatMap((frame) =>
    list(`examples/${kind}/${frame}`).map((file) => ({
      frame,
      file,
      json: readJson(`examples/${kind}/${frame}/${file}`),
    })),
  );
const valid = examples('valid');

const names = (messages) =>
  messages
    .all()
    .map((message) => message.name())
    .sort();

describe('the AsyncAPI document', () => {
  test('parses with no errors or warnings', () => {
    assert.ok(document, 'the document did not parse');
    assert.deepEqual(
      diagnostics.filter((diagnostic) => diagnostic.severity <= 1).map((d) => `${d.code}: ${d.message}`),
      [],
    );
  });

  test('carries every frame, and binary audio, on the connection an agent opens', () => {
    assert.deepEqual(
      names(document.channels().get('agentConnection').messages()),
      [...frames, 'audio'].sort(),
    );
  });

  test('carries every frame but connection.draining on the connection Sent opens', () => {
    assert.deepEqual(
      names(document.channels().get('agentEndpoint').messages()),
      [...frames, 'audio'].filter((name) => name !== 'connection.draining').sort(),
    );
  });

  test('sends and receives each message as its x-sent-direction says', () => {
    for (const operation of document.operations().all()) {
      const sender = operation.action() === 'send' ? 'sent' : 'agent';
      for (const message of operation.messages().all()) {
        assert.ok(
          [sender, 'both'].includes(rules[message.name()].direction),
          `${operation.id()} carries ${message.name()}`,
        );
      }
    }
  });

  test('marks each frame with the scope its schema gives it', () => {
    for (const message of document
      .messages()
      .all()
      .filter((message) => message.name() !== 'audio')) {
      const schema = schemas[message.name()];
      const { scope, sessionTypes } = rules[message.name()];
      const session = scope === 'session';
      assert.equal(schema.required.includes('session_id'), session, message.name());
      assert.equal(Boolean(sessionTypes), session, message.name());
    }
  });

  test('has the version of the package, as do the README and docs/protocol.md', () => {
    assert.equal(document.info().version(), version);
    for (const file of ['README.md', 'docs/protocol.md'])
      assert.match(read(file), new RegExp(`version ${version}\\b`));
  });
});

describe('the frame schemas', () => {
  test('each fixes its type to its file name', () => {
    for (const frame of frames) assert.deepEqual(schemas[frame].properties.type, { const: frame });
  });

  test('each has at least one valid example', () => {
    const covered = new Set(valid.map(({ frame }) => frame));
    assert.deepEqual(
      frames.filter((frame) => !covered.has(frame)),
      [],
    );
  });

  for (const { frame, file, json } of valid) {
    test(`accept ${frame} ${file}`, () => {
      assert.ok(validators[frame](json), ajv.errorsText(validators[frame].errors));
    });
  }

  for (const { frame, file, json } of examples('invalid')) {
    test(`refuse ${frame} ${file}`, () => {
      assert.equal(validators[frame](json), false);
    });
  }

  test('accept fields they do not know, so a frame can grow without breaking older readers', () => {
    for (const { frame, json } of valid)
      assert.ok(validators[frame]({ ...json, added_in_a_later_version: true }), frame);
  });
});
