# Sample agents

Two echo agents on the Sent Voice Agents protocol, written on the raw protocol with no SDK, in the two
languages most agents start in. Each is the smallest agent that takes a real call and keeps it through a lost
connection, so it shows the shape of a complete agent rather than one frame at a time.

| Sample              | Runs on             | Depends on   |
| ------------------- | ------------------- | ------------ |
| [`node/`](node)     | Node 22, TypeScript | `ws`         |
| [`python/`](python) | Python 3.12         | `websockets` |

The frame fixtures the repository's own tests check the schemas with are next to them, in [`valid/`](valid) and
[`invalid/`](invalid).

## What they do

Both do the same thing, frame for frame:

| When Sent sends                      | The agent                                                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `connection.ready`                   | Logs the protocol version, and resumes the sessions it was carrying, if any                                |
| `ping`                               | Answers `pong` with the same `ts`                                                                          |
| `session.start` for a text session   | Greets the caller with one `agent.say`                                                                     |
| `session.start` for an audio session | Nothing. It waits for audio                                                                                |
| `user.said`                          | Says the caller's latest line back, or runs the command it names                                           |
| `user.said` with `correction: true`  | Sends `agent.clear`, then answers the corrected line                                                       |
| Audio                                | Sends the same frame back, on the same stream                                                              |
| `tool.result`                        | Logs it                                                                                                    |
| `connection.draining`                | Opens a new connection and, once Sent is ready there, sends `session.resume` for each session with a token |
| The loss of its connection           | Reconnects with exponential backoff, and resumes its sessions the same way                                 |
| `session.resumed`                    | Keeps the next token, moves to the new audio stream, and sends again the frames Sent did not read          |
| `error` with `resume_failed`         | Treats the session as ended                                                                                |
| `error` with `connection_full`       | Resumes the session on another connection                                                                  |
| `session.end`                        | Logs the reason                                                                                            |

A command is the caller's whole latest line, in any case and with any punctuation:

| The caller says          | The agent sends                                                         |
| ------------------------ | ----------------------------------------------------------------------- |
| transfer                 | `agent.say`, then `tool.call` `transfer` to the number in `TRANSFER_TO` |
| hold                     | `agent.say`, then `tool.call` `hold` with `held: true`                  |
| resume                   | `tool.call` `hold` with `held: false`, then `agent.say`                 |
| hang up, goodbye, or bye | `agent.say` with "Goodbye.", then `tool.call` `hangup`                  |
| Anything else            | `agent.say` with the same words                                         |

The `tool.call` comes after the `agent.say`, and Sent runs a tool after the speech queued before it, so the
caller hears the goodbye before the call ends.

Each sample counts Sent's frames per session as [Counting frames](../docs/protocol.md#counting-frames) says,
keeps the latest resume token, and keeps its last 32 counted frames to send again after a resume. Each logs one
line per event, and never logs the API key or a resume token.

## Run one against your agent

1. Create a voice agent with `POST /v3/voice/agents`, as the [API reference](https://docs.sent.dm) describes,
   with `transfer`, `hold` and `hangup` in its `tools`, and the number you will transfer to in its
   `transfer_targets`. Leave its `greeting` empty: the sample greets, and with both set the caller hears two
   greetings.
2. Route a number to the agent, as the docs describe.
3. Start the sample with the environment below, and call the number.

The environment, the same for both samples:

| Variable         | Required | What it is                                                                                        |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `SENT_API_KEY`   | yes      | The account API key. The sample sends it as a bearer token on the connect, never in the URL       |
| `SENT_AGENT_ID`  | yes      | The agent's id, `agent_…`, from `POST /v3/voice/agents`                                           |
| `SENT_VOICE_URL` | no       | Where to connect. `wss://voice.sent.dm/v1/agents/connect` when unset                              |
| `TRANSFER_TO`    | no       | The E.164 number the transfer command moves the call to. Without it, the agent says there is none |

Node:

```sh
cd examples/node
npm install
SENT_API_KEY=sk_live_… SENT_AGENT_ID=agent_… TRANSFER_TO=+14155550123 npm start
```

Python:

```sh
cd examples/python
SENT_API_KEY=sk_live_… SENT_AGENT_ID=agent_… TRANSFER_TO=+14155550123 uv run python -m sent_echo_agent
```

Each sample's README says how to run its tests, which check every frame it can send against
[the schemas](../schemas) and the counting a resume depends on. Stop a sample with Ctrl-C: it closes its
connections with code 1000, so its calls follow the agent's `fallback` at once instead of waiting out the
resume window.

## Check a sample against the harness

The samples are not the conformance agent of [`conformance/`](../conformance): they greet and answer in their
own words. The scenarios that do not depend on those words run against them, from the repository root, with
the harness playing Sent's side:

```sh
pnpm install
pnpm conformance --only 08-audio-echo --only 09-heartbeat --only 14-resume-on-draining \
  --agent 'SENT_VOICE_URL=$SENT_CONFORMANCE_URL SENT_API_KEY=conformance SENT_AGENT_ID=agent_conformance node --experimental-strip-types examples/node/src/agent.ts'
```

For the Python sample, the agent command is
`uv run --python 3.12 --directory examples/python python -m sent_echo_agent`, with the same environment.

## What a production agent does beyond this

- **Its own speech or model.** In a text session, answer with a language model and stream the reply with
  `agent.say` `last: false` so speech starts before the reply is complete. In an audio session, run
  speech-to-text and text-to-speech, or a speech model, on the 16-bit PCM both ways, and send `agent.clear`
  when the caller talks over the agent.
- **Idempotent tool handling.** After `session.resumed` the agent sends again the counted frames Sent did
  not read, and one of them can be a `tool.call`. Make each tool call safe to send twice: key its side
  effects on `call_ref`, and expect a `tool.result` for a `call_ref` from before the resume.
- **Resume after a restart.** The samples hold tokens and counts in memory, so their calls end with
  `agent_unreachable` when the process restarts. Persist each session's latest token, its `received`, and its
  last 32 counted frames as they change, and on start send `session.resume` for each one within `window_ms`.
- **Enough connections.** Sent puts at most `max_sessions` sessions on one connection. Open more to take more
  calls, and close one with 1000 only when the agent is done with the calls on it.
- **Unknown values.** Treat a `session.end` reason the agent does not know as `failed`, an error code it does
  not know as a failure, and a party kind it does not know as `anonymous`, as
  [Compatibility](../docs/protocol.md#compatibility-and-versions) asks.
