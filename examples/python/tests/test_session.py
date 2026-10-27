import unittest

from sent_echo_agent.audio import audio_frame, samples_of, stream_of
from sent_echo_agent.session import GREETING, RETAINED_FRAMES, Session, latest_line

ID = "vs_7Hq2Lm9xQa"
TOKEN = "vsr_9fK2mQ7xLp4ZbT8wNc3RjV6hYd"
NEXT = "vsr_Hn5tW1qGz8kXc4PmR7vB2sLf0J"


def start(**overrides):
    frame = {
        "type": "session.start",
        "session_id": ID,
        "call_id": "call_01JBX6Y3R0QK5D8M2T4W6Z9C1E",
        "agent_id": "agent_01JBX6Y3NHZ9V3K7T2Q5R8M4PA",
        "direction": "inbound",
        "from": {"kind": "number", "value": "+14155550100"},
        "to": {"kind": "number", "value": "+14155550199"},
        "session_type": "text",
        "started_at": "2026-10-23T12:00:00Z",
        "resume": {"token": TOKEN, "window_ms": 15000},
    }
    frame.update(overrides)
    return {key: value for key, value in frame.items() if value is not None}


def said(text, correction=False):
    frame = {"type": "user.said", "session_id": ID, "text": text}
    if correction:
        frame["correction"] = True
    return frame


def resumed(received, token=NEXT, **extra):
    frame = {"type": "session.resumed", "session_id": ID, "received": received, **extra}
    if token:
        frame["resume"] = {"token": token, "window_ms": 15000}
    return frame


def texts(frames):
    return [frame["text"] if frame["type"] == "agent.say" else frame["type"] for frame in frames]


def tools(frames):
    return [(frame["name"], frame.get("arguments")) for frame in frames if frame["type"] == "tool.call"]


class Counting(unittest.TestCase):
    def test_counts_each_of_sents_frames_except_those_marked_uncounted(self):
        session = Session(start())
        self.assertEqual(session.received, 0)
        session.read(said("one"))
        session.read({"type": "tool.result", "session_id": ID, "call_ref": "t1", "ok": True})
        self.assertEqual(session.received, 2)
        session.read({"type": "error", "session_id": ID})
        session.read({"type": "session.resumed", "session_id": ID})
        self.assertEqual(session.received, 2, "error and session.resumed do not count")
        session.read({"type": "user.waited", "session_id": ID})
        self.assertEqual(session.received, 3, "a frame type the sample does not know counts")
        session.read({"type": "session.end", "session_id": ID})
        self.assertEqual(session.received, 4)

    def test_counts_the_agents_frames_and_goes_back_to_what_sent_read(self):
        session = Session(start())
        session.greeting()
        session.read(said("one"))
        session.read(said("two"))
        self.assertEqual(session.sent, 3)
        again = session.resumed(resumed(1))
        self.assertEqual(texts(again), ["one", "two"], "the frames Sent did not read go again, in order")
        self.assertEqual(session.sent, 3)


class ResumePayload(unittest.TestCase):
    def test_carries_the_latest_token_and_the_count_of_sents_frames_read(self):
        session = Session(start())
        session.read(said("one"))
        self.assertEqual(
            session.resume_frame(),
            {"type": "session.resume", "session_id": ID, "token": TOKEN, "received": 1},
        )
        session.resumed(resumed(2))
        session.read(said("two"))
        self.assertEqual(
            session.resume_frame(),
            {"type": "session.resume", "session_id": ID, "token": NEXT, "received": 2},
        )

    def test_does_not_exist_without_a_token(self):
        session = Session(start(resume=None))
        self.assertIsNone(session.token)
        with self.assertRaises(ValueError):
            session.resume_frame()


class Resumed(unittest.TestCase):
    def test_hangs_up_when_sent_needs_a_frame_no_longer_kept(self):
        session = Session(start())
        for line in range(RETAINED_FRAMES + 1):
            session.read(said(f"line {line}"))
        self.assertEqual(session.sent, RETAINED_FRAMES + 1)
        self.assertEqual(tools(session.resumed(resumed(0))), [("hangup", None)])

    def test_sends_nothing_more_when_the_session_ended_while_detached(self):
        session = Session(start())
        session.read(said("one"))
        self.assertEqual(session.resumed(resumed(0, token=None)), [])
        self.assertIsNone(session.token)

    def test_takes_the_stream_the_audio_session_has_on_the_new_connection(self):
        session = Session(start(session_type="audio", audio={"stream": 7, "sample_rate": 24000}))
        self.assertEqual((session.stream, session.sample_rate), (7, 24000))
        session.resumed(resumed(0, audio={"stream": 3}))
        self.assertEqual(session.stream, 3)


class WhatTheCallerHears(unittest.TestCase):
    def test_a_greeting_in_a_text_session_and_nothing_in_an_audio_session(self):
        self.assertEqual(texts(Session(start()).greeting()), [GREETING])
        self.assertEqual(Session(start(session_type="audio", audio={"stream": 1})).greeting(), [])

    def test_the_latest_line_said_back(self):
        session = Session(start())
        self.assertEqual(texts(session.read(said("Hello there"))), ["Hello there"])
        self.assertEqual(texts(session.read(said("Hello there\nAnd again.", True))), ["agent.clear", "And again."])
        self.assertEqual(latest_line("  one \n\n two  \n"), "two")

    def test_a_tool_for_each_command_however_it_is_said(self):
        session = Session(start(), transfer_to="+14155550123")
        to = {"to": {"kind": "number", "value": "+14155550123"}}
        self.assertEqual(tools(session.read(said("Transfer."))), [("transfer", to)])
        self.assertEqual(tools(session.read(said("hold"))), [("hold", {"held": True})])
        self.assertEqual(tools(session.read(said("Resume!"))), [("hold", {"held": False})])
        self.assertEqual(tools(session.read(said("Hang up"))), [("hangup", None)])
        self.assertEqual(tools(session.read(said("goodbye"))), [("hangup", None)])
        self.assertEqual(tools(session.read(said("hold the line"))), [], "an echo, not a command")

    def test_the_transfer_command_without_a_target_is_refused_in_speech(self):
        self.assertEqual(texts(Session(start()).read(said("transfer"))), ["No transfer target is set."])


class AudioFrame(unittest.TestCase):
    def test_starts_with_the_stream_big_endian_then_the_samples(self):
        samples = bytes([0x01, 0x00, 0xFF, 0x7F])
        frame = audio_frame(7, samples)
        self.assertEqual(frame, bytes([0x00, 0x07, 0x01, 0x00, 0xFF, 0x7F]))
        self.assertEqual(stream_of(frame), 7)
        self.assertEqual(samples_of(frame), samples)
