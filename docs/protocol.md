# The Sent Voice Agents protocol

Status: **Preview**, version 0.1.0. The protocol may change before 1.0.

An agent session is one phone call while one AI agent is on it. Sent and the agent exchange frames over a
WebSocket with the subprotocol `sent.voice.v1`: JSON text messages, one frame per message, and binary messages
for audio. [`asyncapi.yaml`](../asyncapi.yaml) and the [frame schemas](../schemas/frames) say what each frame
contains. This page covers what they cannot express.

Every frame has a `type`. Every frame about a session carries its `session_id`.

## Connecting

There are two ways to connect. Both carry the same frames.

### The agent connects to Sent

This is what the Sent Voice Agents SDKs do. Open a WebSocket to Sent with the account API key, or a short-lived
session token, as a bearer token. Never put the key in the URL.

```
GET wss://voice.sent.dm/v1/agents/connect?agent_id=agent_01JBX6Y3NHZ9V3K7T2Q5R8M4PA
Authorization: Bearer sk_live_...
Sec-WebSocket-Protocol: sent.voice.v1
```

Sent refuses the upgrade with:

| Status | When                                                                              |
| ------ | --------------------------------------------------------------------------------- |
| 400    | `agent_id` or the `sent.voice.v1` subprotocol is missing                          |
| 401    | The key or token is not valid                                                     |
| 403    | Voice is not enabled for the account, or the key's account does not own the agent |
| 404    | The agent does not exist                                                          |

Once connected, Sent sends `connection.ready`, then a `session.start` whenever a call reaches the agent.
`connection.ready` gives the `protocol_version` Sent speaks, the `heartbeat_interval_ms`, and `max_sessions`,
the most sessions Sent puts on the connection at once.

- **One connection carries many sessions**, which run at the same time. To take more calls than `max_sessions`,
  open more connections, for example one per process. The agent's `max_concurrent_calls` setting caps the
  total.
- **Draining.** `connection.draining` means Sent starts no new sessions on that connection, while sessions
  already on it go on. Open a new connection straight away so new calls keep reaching the agent. Sent closes the
  drained connection with code 1001 when its last session ends.

### Sent connects to the agent

When the agent's `websocket_url` is set, Sent opens one connection to that URL for each session, with the
`sent.voice.v1` subprotocol. Sent sends `connection.ready`, then `session.start`, and closes the connection with
code 1000 after `session.end`.

Sent signs the handshake as it signs every webhook, with the agent's `signing_secret`:

| Header                | Value                                                  |
| --------------------- | ------------------------------------------------------ |
| `X-Webhook-ID`        | The agent id, whose `signing_secret` signed it         |
| `X-Webhook-Event-ID`  | The session id                                         |
| `X-Webhook-Timestamp` | Unix seconds when Sent signed the handshake            |
| `X-Webhook-Signature` | `v1,` followed by the Base64 signature described below |

The signature is HMAC-SHA256 of `{X-Webhook-ID}.{X-Webhook-Timestamp}.` followed by an empty payload, because the
handshake has no body. The key is the `signing_secret` with its `whsec_` prefix removed, then Base64-decoded. The
verification snippet in Sent's webhook docs works unchanged with an empty payload.

Refuse the handshake with 401 when the signature does not match, when the timestamp is more than 5 minutes from
your clock, or when you have seen the `X-Webhook-Event-ID` before.

## Order of frames

- Sent's first frame on a connection is `connection.ready`.
- For each session, Sent's first frame is `session.start` and its last is `session.end`. After `session.end` the
  agent sends nothing more for that session.
- `ping`, `pong`, `connection.draining` and `error` belong to the connection, and can come at any time.
- Frames for one session arrive in the order they were sent. Frames for different sessions can interleave.
- Each message's `x-sent-direction`, `x-sent-scope` and `x-sent-session-types` in `asyncapi.yaml` say who sends
  it, whether it belongs to a session, and which session types allow it.

## Limits

- `user.said` and `agent.say` carry at most 4096 characters of `text`.
- A text frame is at most 64 KB. Sent refuses a larger one with `invalid_frame`.
- An outbound call's `context` is at most 4 KB as JSON.

## Text sessions

In a text session (`session_type: "text"`), Sent runs speech-to-text and text-to-speech.

- **`user.said`** carries one complete utterance from the caller, once Sent has transcribed it. There are no
  interim partial results. A `user.said` with `correction: true` replaces the previous one, because Sent
  transcribed the speech again after a pause. If you already sent speech answering the replaced utterance, send
  `agent.clear` and answer the correction.
- **`agent.say`** is spoken in the order it arrives. To start speaking before a reply is complete, send it in
  pieces with `last: false` and finish with `last: true`, the default. The pieces are spoken as one utterance.
- **Interruptions.** While `interruptible` is true, the default, the caller speaking stops the agent's speech
  and drops the speech still queued.
- **Greeting.** When the agent has a `greeting` setting, Sent speaks it right after `session.start`. Otherwise
  the agent can speak first or wait for the caller.

## Audio sessions

In an audio session (`session_type: "audio"`), the agent runs its own speech. Sent sends the caller's audio and
plays the audio the agent sends, as binary messages of 16-bit little-endian mono PCM, at the `sample_rate` in
`session.start`'s `audio`. 16000 Hz is the default.

Each binary message carries audio for one session:

| Bytes | Content                                                                    |
| ----- | -------------------------------------------------------------------------- |
| 0–1   | The session's `stream` from `session.start`'s `audio`, big-endian unsigned |
| 2 on  | Audio, a whole number of samples                                           |

The 2-byte header keeps the samples aligned, so a reader can view them as 16-bit integers without copying.

- Send 20 ms of audio per message, which is 640 bytes at 16000 Hz, and no more than 200 ms.
- Sent sends the caller's audio for the whole session, silence included.
- Sent plays the agent's audio in the order it arrives.
- `user.said` and `agent.say` are not allowed in an audio session.

## Stopping speech

**`agent.clear`** drops the speech or audio the agent sent that Sent has not played yet, in either session type:
for example when the caller starts talking over the agent, or after a correction.

## Tools

The agent acts on the call with `tool.call`. Sent answers every `tool.call` with exactly one `tool.result`
carrying the same `call_ref`. Choose `call_ref` yourself and keep it unique within the session.

A tool runs after the speech or audio the agent queued before it, so an agent can say goodbye and then hang up.
If the caller interrupts, the queued speech is dropped and the tool runs straight away. To act at once, send
`agent.clear` before the `tool.call`.

| Tool        | `arguments`                                                               | What happens                                                       |
| ----------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `transfer`  | `to`: a party with kind `user`, `number` or `agent`                       | The call moves to the party. Then `session.end` with `transferred` |
| `hangup`    | none                                                                      | The call ends. Then `session.end` with `agent_hung_up`             |
| `send_dtmf` | `digits`: `0` to `9`, `*`, `#`, `A` to `D`, and `w` to wait half a second | Sent plays the digits on the call                                  |
| `hold`      | `held`: true to hold the caller, false to resume                          | The caller hears hold music while held                             |

The agent's `tools` setting decides which tools it may use, and its `transfer_targets` setting decides where it
may transfer. A refused or failed tool answers `ok: false` with an `error`:

| `error.code`         | When                                                  |
| -------------------- | ----------------------------------------------------- |
| `tool_not_allowed`   | The agent's `tools` setting does not include the tool |
| `unknown_tool`       | There is no tool with that name                       |
| `invalid_arguments`  | The arguments do not fit the tool                     |
| `target_not_allowed` | The transfer target is not in `transfer_targets`      |
| `call_not_live`      | The call has already ended or left the agent          |
| `failed`             | The tool was allowed but did not work                 |

## Parties

`from`, `to` and a transfer's `to` are parties, in the same shape as the REST API's call parties: `kind` is
`user` for an app user, `number` for a phone number, `conference` for a room, `agent` for an agent, or
`anonymous` for a caller who withheld their number. `value` is the identity, the E.164 number, the room name or
the agent id, and is absent for `anonymous`.

## Heartbeats

Sent sends `ping` on every connection at the interval `connection.ready` gives in `heartbeat_interval_ms`, 5
seconds today. Answer each one with `pong` carrying the same `ts`.

- When three pings in a row go unanswered, Sent closes the connection with code 4008. It ends the connection's
  sessions with `agent_unreachable`, and each call follows the agent's `fallback`.
- When no `ping` arrives for three intervals, treat the connection as dead and open a new one.

Heartbeats also keep idle proxies and load balancers from closing the connection between calls.

## Ending

`session.end` gives the reason the call left the agent:

| `reason`            | When                                                             |
| ------------------- | ---------------------------------------------------------------- |
| `caller_hung_up`    | The caller hung up                                               |
| `agent_hung_up`     | The agent used `hangup`                                          |
| `transferred`       | The agent used `transfer`                                        |
| `max_duration`      | The session reached `max_duration_ms` from `session.start`       |
| `agent_unreachable` | The agent stopped answering heartbeats or its connection dropped |
| `balance_exhausted` | The account ran out of balance                                   |
| `voice_disabled`    | Voice was turned off for the account                             |
| `failed`            | Anything else                                                    |

## Errors

When Sent cannot accept a frame, it sends `error` and ignores the frame. The connection stays open.

| `error.code`         | When                                                                 |
| -------------------- | -------------------------------------------------------------------- |
| `invalid_frame`      | The frame is not valid JSON, does not match its schema, or too large |
| `unknown_frame_type` | Sent does not know the frame's `type`                                |
| `unknown_session`    | No session with that `session_id` is on this connection              |
| `frame_not_allowed`  | The frame is not allowed in this session type                        |
| `session_ended`      | The session has already ended                                        |

Sent closes a connection with:

| Code | When                                                         |
| ---- | ------------------------------------------------------------ |
| 1000 | Sent connected to the agent, and the session ended           |
| 1001 | The connection drained, or Sent is shutting down             |
| 4003 | Voice was turned off for the account, or the key was revoked |
| 4008 | Three pings went unanswered                                  |

## Compatibility and versions

Within `sent.voice.v1`, Sent only adds: fields, frame types, tools, party kinds, `session.end` reasons and error
codes. The schemas accept values they do not list for the last four. So that an agent built today keeps working:

- Ignore fields and frame types you do not know.
- Treat a `session.end` reason you do not know as `failed`, and an error code you do not know as a failure.
- Answer a party kind you do not know as you would an `anonymous` caller.

Releases of this repository are tags such as `v0.1.0`. The Sent Voice Gateway and every Sent Voice Agents SDK
pin one, as a git submodule or the tag's source archive, and `connection.ready` gives the `protocol_version` the
gateway speaks. While the protocol is in Preview, a 0.x release can still change frames under `sent.voice.v1`.
From 1.0, release N.x is `sent.voice.vN`: a change that would break an agent gets a new major release and a new
subprotocol, and Sent serves both for a deprecation period.
