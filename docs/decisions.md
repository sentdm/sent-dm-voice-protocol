# Decisions

Why [the protocol](protocol.md) is shaped the way it is, where the Sent Voice products spec left a choice open.
Each can change while the protocol is in Preview.

## Two ways to connect, one set of frames

An SDK needs one session implementation, and a team can move between connecting to Sent and being connected to
without changing its agent code.

## One agent connection carries many sessions

An agent process holds one long-lived connection instead of one per call, which is how the SDKs' `agent.run()`
works, and a new call starts without a handshake. `max_sessions` bounds how many calls share one connection's
TCP stream, so a lost packet or a large frame stalls only those. When Sent connects to the agent, it opens one
connection per session instead, because the agent's own server decides how to spread connections.

## Binary audio frames start with a 2-byte stream number

Audio stays binary, which is a third smaller than Base64 in JSON. One connection can carry several audio
sessions, so each frame names its session, but with a number `session.start` assigns rather than the session id:
a fixed 2-byte header keeps the samples aligned and costs no string parsing 50 times a second. The subprotocol
version covers the layout, so the header has no version byte.

## Parties and times use the REST API's shapes

`from`, `to` and transfer targets are `{ "kind", "value" }`, the REST API's call party and the shape of an
agent's `transfer_targets`, and `started_at` is ISO 8601 as in the REST API, so the same names mean the same
things in both. The spec's draft frames used `identity` for an app user and epoch milliseconds, and both were
dropped.

## Heartbeats are frames, every 5 seconds

Not every WebSocket library lets application code see or send control frames, while every library can read and
write a JSON frame, and the conformance suite can test a frame. They belong to the connection. Five seconds
finds a dead agent within 15 and keeps idle load balancers from closing a connection between calls. The spec's
15 seconds would leave a caller in silence for up to 45.

## `agent.say` can be streamed

`last: false` lets an agent send a model's reply as it is generated, so speech starts before the reply is
complete. A plain reply is still one frame.

## Tools wait for queued speech

Without an order, an agent saying goodbye before `hangup` would have to guess how long the speech takes, paying
for the guess or cutting the goodbye off. `agent.clear` acts at once when that is what the agent wants, and it
works in both session types, so there is one way to stop speech.

## The handshake is signed like a Sent webhook

Customers verify it with the snippet they already run. `X-Webhook-ID` names the agent whose secret signed it, as
it names the signing configuration on every Sent webhook, and `X-Webhook-Event-ID` carries the session id to
deduplicate on.

## Lists of values can grow

Party kinds, `session.end` reasons, error codes and tool names are open: the schemas list the known values and
accept any other snake_case value. Closed enums would make a generated SDK reject the first value Sent adds,
which is what `sent.voice.v1` promises to allow.

## Not in 0.1.0

Candidates for a later version, left out until an agent needs them:

- the caller's keypresses (DTMF) as a frame
- telling a text agent how much of its speech was played before an interruption
- playback markers for audio sessions
- 8 kHz µ-law audio, a quarter of the bytes of 16 kHz PCM, for agents whose models take it
- tools beyond the four built-in ones, such as sending an SMS
- the endpoint that mints session tokens
