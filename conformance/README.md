# Conformance

Every Sent Voice Agents SDK passes the same conformance run before it is released. The harness plays Sent's side
of the protocol: it accepts the agent's connection the way `wss://voice.sent.dm` does, runs each scenario in
[`scenarios/`](scenarios), and checks every frame the agent sends against [the schemas](../schemas/frames) and
the rules in [`asyncapi.yaml`](../asyncapi.yaml).

## Run it against an SDK

In the SDK's CI, use this repository as an action, at the tag of the protocol version the SDK implements:

```yaml
- uses: sentdm/sent-dm-voice-protocol@v0.1.2
  with:
    agent: node examples/conformance-agent.js
```

The action starts the harness, then runs `agent` from the workspace with `SENT_CONFORMANCE_URL` set to the URL to
connect to. It stops the agent when the run ends and fails the job when a scenario fails. It needs Node 20.11 or
later on the runner, which GitHub's hosted runners have.

To run it by hand, check out this repository, then:

```sh
pnpm install
pnpm conformance --agent "<the command that starts your agent>"
```

Without `--agent`, the harness waits for an agent at `ws://localhost:8765/v1/agents/connect`. `--port` changes
the port, `--only <scenario>` runs one scenario, and `--timeout <ms>` changes how long a step waits, 3000 by
default. The harness exits 0 when every scenario passes and 1 otherwise, naming the failing step:

```
ok 1 - 01-greeting-and-echo
not ok 2 - 02-streamed-reply
  # step 4: expected {"type":"agent.say","session_id":"vs_conf02a","text":"Let","last":false}, got ...
```

## The conformance agent

Each SDK ships a small agent, written with its own API, that connects to `SENT_CONFORMANCE_URL` with any API key
and does exactly this:

| When it receives                           | It sends                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| `session.start` for a text session         | `agent.say` with `Hello from the conformance agent.`                        |
| `user.said` `echo <text>`                  | `agent.say` with `<text>`                                                   |
| `user.said` `stream <word> <rest>`         | `agent.say` with `<word>` and `last: false`, then `agent.say` with `<rest>` |
| `user.said` `transfer`                     | `tool.call` `transfer` to `{ "kind": "user", "value": "conformance-desk" }` |
| `user.said` `hangup`                       | `tool.call` `hangup`                                                        |
| `user.said` `dtmf <digits>`                | `tool.call` `send_dtmf` with `<digits>`                                     |
| `user.said` `hold`                         | `tool.call` `hold` with `held: true`                                        |
| `user.said` with `correction: true`        | `agent.clear`, then what the corrected text asks for                        |
| `tool.result` with `ok: false`             | `agent.say` with `Tool failed: <error.code>`                                |
| Audio in an audio session                  | The same audio, on the same stream                                          |
| `ping`                                     | `pong` with the same `ts`                                                   |
| `connection.draining`                      | A new connection, keeping the old one until Sent closes it                  |
| Anything else, or a field it does not know | Nothing                                                                     |

A command is the text up to the first space, and `<word>` is the text from there to the next space.
[`reference-agent.js`](reference-agent.js) is this agent on the raw protocol, with no SDK. The tests run it
against the harness, and so does CI through the action, so it always passes.

## What the harness checks

Each frame the agent sends must be valid against its schema and keep the rules each message carries in
`asyncapi.yaml`: an agent never sends a frame only Sent sends, a session frame names a session that is open, and
the session's type allows the frame. A frame for one session must come in order, but two sessions' frames may
interleave, as they would from an agent that serves each session on its own task.

The harness refuses a connection without a bearer token, an `agent_id` or the `sent.voice.v1` subprotocol, and
reports the refusal at once. A connection the agent closes fails every step still waiting on it, also at once.

## Scenarios

A scenario is a JSON file with a `description` and `steps`, run in order on one connection:

| Step               | What the harness does                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------ |
| `send`             | Sends the frame                                                                            |
| `expect`           | Waits for the agent's next frame for the same session, which must carry every field given  |
| `capture`          | With `expect`: remembers fields of that frame, such as `{ "ref": "call_ref" }`, for `$ref` |
| `send_audio`       | Sends `samples` 16-bit samples on `stream`                                                 |
| `expect_audio`     | Waits for the same samples back on `stream`                                                |
| `expect_reconnect` | Waits for the agent to open a new connection, and carries on there                         |

`$a` and `$b` stand for the scenario's session ids. An `expect` with no `session_id` waits for a connection
frame such as `pong`. A field an expected frame leaves out counts as its schema default, so an agent may omit
`last: true`. After the last step the harness pings and waits for the pong, and any frame the agent sent that no
step expected fails the scenario.

Not covered yet: Sent connecting to the agent's `websocket_url` with a signed handshake, and the agent's handling
of `error` frames.
