# Echo agent in TypeScript on Node 22

The sample agent of [`examples/README.md`](../README.md), on Node 22 with [`ws`](https://github.com/websockets/ws)
as its one runtime dependency. Node runs the TypeScript as it is, with type stripping, so there is no build.

| File                   | What it holds                                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `src/agent.ts`         | The connections: connecting, heartbeats, draining, reconnecting with backoff, and moving sessions with `session.resume` |
| `src/session.ts`       | One session, with no socket: what to say back, the count of Sent's frames read, and the resume payload                  |
| `src/frames.ts`        | The frames the sample reads and sends, with the field names of the schemas                                              |
| `src/audio.ts`         | The binary audio frame: the 2-byte stream header, then the samples                                                      |
| `test/frames.test.ts`  | Every frame the sample can send, checked against [the schemas](../../schemas) with Ajv                                  |
| `test/session.test.ts` | The per-session counting, the resume payload, what `session.resumed` makes the sample send, and the commands            |

## Run

```sh
npm install
SENT_API_KEY=sk_live_… SENT_AGENT_ID=agent_… npm start
```

The environment is in [`examples/README.md`](../README.md#run-one-against-your-agent). The sample needs Node
22.6 or later, and prints one line per event:

```
2026-10-27T12:39:23.805Z session.start vs_6ive5w3q2v6l5uad5peudknv5q text inbound from +14155550100 resumable for 15000 ms
2026-10-27T12:40:36.276Z draining moving 1 session(s)
2026-10-27T12:40:36.492Z ready protocol 0.2.0 up to 50 sessions resuming 1
2026-10-27T12:40:36.543Z session.resumed vs_6ive5w3q2v6l5uad5peudknv5q Sent read 5 of the agent's frames sending 0 again
```

## Test

```sh
npm test
npm run typecheck
```

`npm test` runs the two test files with `node --test`. `npm run typecheck` runs `tsc` with no output, with the
options type stripping needs: `.ts` extensions on imports, `import type`, and no TypeScript-only runtime syntax.
