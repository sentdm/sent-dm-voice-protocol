"""Every frame the sample can send is valid against the protocol's schemas, three directories up."""

import json
import unittest
from pathlib import Path

from jsonschema import Draft7Validator
from referencing import Registry, Resource

from sent_echo_agent.session import RETAINED_FRAMES, Session, pong

SCHEMAS = Path(__file__).resolve().parents[3] / "schemas"
ID = "vs_7Hq2Lm9xQa"
RESUME = {"token": "vsr_9fK2mQ7xLp4ZbT8wNc3RjV6hYd", "window_ms": 15000}
START = {
    "type": "session.start",
    "session_id": ID,
    "call_id": "call_01JBX6Y3R0QK5D8M2T4W6Z9C1E",
    "agent_id": "agent_01JBX6Y3NHZ9V3K7T2Q5R8M4PA",
    "direction": "inbound",
    "from": {"kind": "number", "value": "+14155550100"},
    "to": {"kind": "number", "value": "+14155550199"},
    "session_type": "text",
    "started_at": "2026-10-23T12:00:00Z",
    "resume": RESUME,
}


def read(file):
    return json.loads((SCHEMAS / file).read_text())


COMMON = read("common.json")
# The frame schemas reference ../common.json by the $id it carries.
REGISTRY = Registry().with_resource(COMMON["$id"], Resource.from_contents(COMMON))


def validator(frame_type):
    return Draft7Validator(read(f"frames/{frame_type}.json"), registry=REGISTRY)


def said(text, correction=False):
    frame = {"type": "user.said", "session_id": ID, "text": text}
    if correction:
        frame["correction"] = True
    return frame


def every_frame():
    """Everything the sample sends over one scripted call, each frame with what brought it about."""
    frames = []

    def add(origin, *sent):
        frames.extend((origin, frame) for frame in sent)

    session = Session(START, transfer_to="+14155550123")
    add("ping", pong({"type": "ping", "ts": 1792411215000}))
    add("session.start", *session.greeting())
    add("an utterance", *session.read(said("Hello there")))
    add("a correction", *session.read(said("Hello there\nHello there, Sent.", True)))
    add("transfer", *session.read(said("Transfer.")))
    add("hold", *session.read(said("Hold")))
    add("resume", *session.read(said("resume")))
    add("a lost connection", session.resume_frame())
    add("session.resumed", *session.resumed({"type": "session.resumed", "session_id": ID, "received": 2, "resume": RESUME}))
    add("goodbye", *session.read(said("Goodbye!")))
    bare = Session(START)
    add("transfer without a target", *bare.read(said("transfer")))
    for line in range(RETAINED_FRAMES + 1):
        bare.read(said(f"line {line}"))
    add("a frame no longer kept", *bare.resumed({"type": "session.resumed", "session_id": ID, "received": 0, "resume": RESUME}))
    return frames


class EveryFrameTheSampleSends(unittest.TestCase):
    def test_is_valid_against_its_schema(self):
        for origin, frame in every_frame():
            with self.subTest(frame=frame["type"], after=origin):
                errors = [error.message for error in validator(frame["type"]).iter_errors(frame)]
                self.assertEqual(errors, [])

    def test_covers_every_frame_type_and_tool_the_sample_uses(self):
        frames = [frame for _, frame in every_frame()]
        self.assertEqual(
            sorted({frame["type"] for frame in frames}),
            ["agent.clear", "agent.say", "pong", "session.resume", "tool.call"],
        )
        self.assertEqual(
            sorted({frame["name"] for frame in frames if frame["type"] == "tool.call"}),
            ["hangup", "hold", "transfer"],
        )
