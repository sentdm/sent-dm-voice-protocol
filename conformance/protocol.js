// What the harness, the reference agent and the tests know about the protocol, read from asyncapi.yaml and
// the frame schemas so that none of them restates it.
import { Parser, fromFile } from '@asyncapi/parser';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import fs from 'node:fs';
import path from 'node:path';

export const root = path.resolve(import.meta.dirname, '..');
export const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
export const { version } = readJson('package.json');

/** The parsed asyncapi.yaml, and what the parser said about it. */
export const { document: spec, diagnostics } = await fromFile(
  new Parser(),
  path.join(root, 'asyncapi.yaml'),
).parse();

// The connection an agent opens. Optional chaining keeps a broken spec a failing test rather than a crash.
const agentConnection = spec?.channels().get('agentConnection');
export const connectPath = agentConnection?.address();
export const subprotocol = agentConnection?.bindings().get('ws')?.value().headers.properties[
  'Sec-WebSocket-Protocol'
].const;

/** How many of its latest counted frames each side keeps for each session, to send again on a resume. */
export const retainedFrames = agentConnection?.extensions().get('x-sent-retained-frames')?.value();

/** Where the harness listens when not told otherwise. */
export const defaultPort = 8765;

const extension = (message, name) => message.extensions().get(name)?.value();

/**
 * Each message's x-sent rules: who sends it, its scope, the session types that allow it, and whether it counts
 * towards a resume's received when it carries a session_id.
 */
export const rules = Object.fromEntries(
  (spec?.messages().all() ?? []).map((message) => [
    message.name(),
    {
      direction: extension(message, 'x-sent-direction'),
      scope: extension(message, 'x-sent-scope'),
      sessionTypes: extension(message, 'x-sent-session-types'),
      counted: extension(message, 'x-sent-counted') ?? true,
    },
  ]),
);

/** Every frame type, from the schema file names. */
export const frameTypes = fs
  .readdirSync(path.join(root, 'schemas/frames'))
  .map((file) => file.replace(/\.json$/, ''))
  .sort();

/** Each frame's schema, by type. */
export const schemas = Object.fromEntries(
  frameTypes.map((type) => [type, readJson(`schemas/frames/${type}.json`)]),
);

// strictTypes fails on a subschema that uses object keywords without saying it is an object. useDefaults
// fills in the fields a frame leaves out, so a frame that omits last: true reads as one that sends it.
export const ajv = new Ajv({ allErrors: true, strictTypes: true, useDefaults: true });
addFormats(ajv);
ajv.addSchema(readJson('schemas/common.json'));

/** A compiled validator for each frame type. */
export const validators = Object.fromEntries(frameTypes.map((type) => [type, ajv.compile(schemas[type])]));

/** Why a frame is not valid, or undefined when it is. Fills in the defaults of the fields it leaves out. */
export function frameErrors(frame) {
  const validate = validators[frame?.type];
  if (!validate) return `unknown frame type ${JSON.stringify(frame?.type)}`;
  return validate(frame) ? undefined : ajv.errorsText(validate.errors);
}

/**
 * Why an agent may not send this frame now, or undefined when it may. `sessions` maps each open session id
 * to its session type.
 */
export function agentFrameErrors(frame, sessions) {
  const errors = frameErrors(frame);
  if (errors) return `an invalid ${frame?.type ?? 'frame'}: ${errors}`;
  const { direction, scope, sessionTypes } = rules[frame.type];
  if (direction === 'sent') return `${frame.type}, which only Sent sends`;
  if (scope !== 'session') return undefined;
  const type = sessions.get(frame.session_id);
  if (!type) return `${frame.type} for ${frame.session_id}, which is not an open session`;
  if (!sessionTypes.includes(type)) {
    return `${frame.type} in ${type} session ${frame.session_id}, and ${frame.type} is for ${sessionTypes.join(' and ')} sessions only`;
  }
  return undefined;
}

/** The binary audio layout: a 2-byte big-endian stream number, then the samples. */
export const audioFrame = {
  encode: (stream, samples) => {
    const frame = Buffer.alloc(2 + samples.length);
    frame.writeUInt16BE(stream, 0);
    samples.copy(frame, 2);
    return frame;
  },
  decode: (frame) => ({ stream: frame.readUInt16BE(0), samples: frame.subarray(2) }),
};
