# Echo agent in Python 3.12

The sample agent of [`examples/README.md`](../README.md), on Python 3.12 with
[`websockets`](https://websockets.readthedocs.io) as its one dependency.

| File                         | What it holds                                                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `sent_echo_agent/agent.py`   | The connections: connecting, heartbeats, draining, reconnecting with backoff, and moving sessions with `session.resume` |
| `sent_echo_agent/session.py` | One session, with no socket: what to say back, the count of Sent's frames read, and the resume payload                  |
| `sent_echo_agent/audio.py`   | The binary audio frame: the 2-byte stream header, then the samples                                                      |
| `tests/test_frames.py`       | Every frame the sample can send, checked against [the schemas](../../schemas) with `jsonschema`                         |
| `tests/test_session.py`      | The per-session counting, the resume payload, what `session.resumed` makes the sample send, and the commands            |

## Run

With [uv](https://docs.astral.sh/uv/), which installs Python 3.12 and `websockets` on first use:

```sh
SENT_API_KEY=sk_live_… SENT_AGENT_ID=agent_… uv run python -m sent_echo_agent
```

With a virtual environment of your own:

```sh
python3.12 -m venv .venv && . .venv/bin/activate
pip install websockets
SENT_API_KEY=sk_live_… SENT_AGENT_ID=agent_… python -m sent_echo_agent
```

The environment is in [`examples/README.md`](../README.md#run-one-against-your-agent). The sample prints one
line per event, as the Node sample does.

## Test

```sh
uv run python -m unittest
```

Or, in your own virtual environment, `pip install jsonschema` and `python -m unittest`. The tests need the
repository around them: they read the schemas from `../../schemas`.
