# Sent Voice Agents protocol

The protocol an AI agent speaks to take and place phone calls through [Sent](https://sent.dm): the session an
agent holds while it is on a call, over a WebSocket at `wss://voice.sent.dm`. Any language with a WebSocket
client can build an agent from it, with or without a Sent Voice Agents SDK.

Status: **Preview**, version 0.1.1. The protocol is not released yet and may change before 1.0.

## What is here

| Path                                     | What it is                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| [`docs/protocol.md`](docs/protocol.md)   | How to connect, the order of frames, audio, tools, heartbeats and compatibility |
| [`asyncapi.yaml`](asyncapi.yaml)         | The protocol as an AsyncAPI 3.1 document: connections, frames and examples      |
| [`schemas/`](schemas)                    | A JSON Schema (draft-07) for each frame, which `asyncapi.yaml` references       |
| [`examples/`](examples)                  | Valid frames, and frames each schema must refuse                                |
| [`docs/decisions.md`](docs/decisions.md) | Why the protocol is shaped the way it is                                        |
| [`conformance/`](conformance)            | The harness, its scenarios and the agent every SDK writes to pass them          |
| [`action.yml`](action.yml)               | The GitHub Action an SDK's CI runs the harness with                             |

## A session in six frames

The agent connects with the account API key, and Sent sends `connection.ready`. When a call reaches the agent:

```json
{"type":"session.start","session_id":"vs_7Hq2Lm9xQa","call_id":"call_01JBX6Y3R0QK5D8M2T4W6Z9C1E","agent_id":"agent_01JBX6Y3NHZ9V3K7T2Q5R8M4PA","direction":"inbound","from":{"kind":"number","value":"+14155550100"},"to":{"kind":"number","value":"+14155550199"},"session_type":"text","language":"en-US","started_at":"2026-10-23T12:00:00Z"}
{"type":"agent.say","session_id":"vs_7Hq2Lm9xQa","text":"Hi, this is Acme support. How can I help?"}
{"type":"user.said","session_id":"vs_7Hq2Lm9xQa","text":"I need to talk to a person"}
{"type":"tool.call","session_id":"vs_7Hq2Lm9xQa","call_ref":"t1","name":"transfer","arguments":{"to":{"kind":"user","value":"support-desk"}}}
{"type":"tool.result","session_id":"vs_7Hq2Lm9xQa","call_ref":"t1","ok":true}
{"type":"session.end","session_id":"vs_7Hq2Lm9xQa","reason":"transferred","duration_ms":48210}
```

## Conformance

Every Sent Voice Agents SDK runs the same conformance scenarios in CI before it is released: a harness plays
Sent's side of whole sessions against the SDK's conformance agent and checks every frame it sends. The SDK runs
it with this repository's action, and [`conformance/`](conformance) says how, and what the agent must do.

`pnpm test` checks this repository itself: the schemas against their examples, `asyncapi.yaml` against the
schemas, and the harness against a reference agent.

## Versions

Releases are tags such as `v0.1.0`, which the Sent Voice Gateway and every SDK pin. How versions relate to the
`sent.voice.v1` subprotocol, and what may change, is under
[Compatibility and versions](docs/protocol.md#compatibility-and-versions).

## License

[Apache License 2.0](LICENSE).
