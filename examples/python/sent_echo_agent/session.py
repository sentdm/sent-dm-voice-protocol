"""What happens inside one session, with no socket in sight: the frames the agent sends in answer to Sent's,
the count of Sent's frames it has read, and what it takes to move the session to another connection. The
agent in agent.py sends every frame a method here returns, in order, on the connection the session is on.

Frames are plain dicts with the field names of schemas/frames/*.json."""

from __future__ import annotations

import re
from typing import Any

Frame = dict[str, Any]

# How many of its latest counted frames each side keeps for each session, to send again on a resume:
# x-sent-retained-frames in asyncapi.yaml.
RETAINED_FRAMES = 32

# Sent's frames that do not count towards received: the ones asyncapi.yaml marks x-sent-counted: false. Every
# other frame with the session's session_id counts, also one of a type this sample does not know.
UNCOUNTED = frozenset({"session.start", "session.resumed", "error"})

GREETING = (
    "Hi, this is the Sent echo agent. I'll say back whatever you say. "
    "Say transfer, hold, resume, or goodbye to try a tool."
)

# What the caller says, once case and punctuation are dropped, to run a tool instead of hearing an echo.
COMMANDS = {
    "transfer": "transfer",
    "hold": "hold",
    "resume": "resume",
    "hang up": "hangup",
    "hangup": "hangup",
    "goodbye": "hangup",
    "bye": "hangup",
}


def pong(ping: Frame) -> Frame:
    """The answer to a ping: a pong with the same ts."""
    return {"type": "pong", "ts": ping["ts"]}


def latest_line(text: str) -> str:
    """The last line of a user.said: a correction carries the whole transcript so far, one utterance per line."""
    lines = [line.strip() for line in text.split("\n")]
    lines = [line for line in lines if line]
    return lines[-1] if lines else ""


def _command(line: str) -> str | None:
    return COMMANDS.get(" ".join(re.sub(r"[^a-z ]", "", line.lower()).split()))


class Session:
    def __init__(self, start: Frame, transfer_to: str | None = None) -> None:
        """`transfer_to` is the E.164 number the transfer command moves the call to. Without it, the command is
        refused in speech."""
        self.id: str = start["session_id"]
        self.call_id: str = start["call_id"]
        self.type: str = start["session_type"]
        audio = start.get("audio") or {}
        # Hz of the session's 16-bit mono PCM, both ways, in an audio session.
        self.sample_rate: int = audio.get("sample_rate", 16000)
        # The number in the header of the session's binary audio frames on its current connection.
        self.stream: int | None = audio.get("stream")
        # The latest resume token, or None when the session cannot be resumed. Keep it out of logs.
        self.token: str | None = (start.get("resume") or {}).get("token")
        # How many of Sent's counted frames for the session the agent has read: the received of a session.resume.
        self.received = 0
        # Audio frames sent back, for the log.
        self.audio_frames = 0
        self._transfer_to = transfer_to
        # The latest counted frames the agent sent, to send again those Sent did not read, and how many came
        # before them.
        self._kept: list[Frame] = []
        self._before = 0
        self._calls = 0

    @property
    def sent(self) -> int:
        """How many counted frames the agent has sent for the session."""
        return self._before + len(self._kept)

    def greeting(self) -> list[Frame]:
        """What to send once the session has started: a text session hears a greeting, an audio session nothing."""
        return [self._say(GREETING)] if self.type == "text" else []

    def read(self, frame: Frame) -> list[Frame]:
        """Reads one of Sent's frames for the session, counts it, and returns the frames to send in answer."""
        if frame["type"] not in UNCOUNTED:
            self.received += 1
        return self._answer(frame) if frame["type"] == "user.said" else []

    def resume_frame(self) -> Frame:
        """The frame that moves the session to a new connection, with its latest token and count."""
        if not self.token:
            raise ValueError(f"session {self.id} has no resume token")
        return {"type": "session.resume", "session_id": self.id, "token": self.token, "received": self.received}

    def resumed(self, frame: Frame) -> list[Frame]:
        """Takes the answer to a session.resume: the next token, the session's stream on the new connection, and
        how many of the agent's frames Sent read. Returns the frames to send again, or a hangup when Sent needs
        one the session no longer keeps."""
        resume = frame.get("resume")
        self.token = resume["token"] if resume else None
        if "audio" in frame:
            self.stream = frame["audio"]["stream"]
        # Without a next token the session ended while it was detached: its replay ends with session.end.
        if not resume:
            return []
        received = frame["received"]
        unread = None if received < self._before else self._kept[received - self._before :]
        self._before = received
        self._kept = []
        if unread is None:
            return [self._tool("hangup")]
        return [self._keep(again) for again in unread]

    def _answer(self, frame: Frame) -> list[Frame]:
        # A correction replaces an utterance this agent has already answered, so that answer is dropped first.
        frames = [self._clear()] if frame.get("correction") else []
        line = latest_line(frame["text"])
        if not line:
            return frames
        match _command(line):
            case "transfer":
                if not self._transfer_to:
                    return frames + [self._say("No transfer target is set.")]
                to = {"kind": "number", "value": self._transfer_to}
                return frames + [self._say("Transferring you now."), self._tool("transfer", {"to": to})]
            case "hold":
                return frames + [self._say("Please hold."), self._tool("hold", {"held": True})]
            case "resume":
                return frames + [self._tool("hold", {"held": False}), self._say("I'm back.")]
            case "hangup":
                # The tool runs after the speech queued before it, so the caller hears the goodbye.
                return frames + [self._say("Goodbye."), self._tool("hangup")]
            case _:
                return frames + [self._say(line)]

    def _say(self, text: str) -> Frame:
        return self._keep({"type": "agent.say", "session_id": self.id, "text": text})

    def _clear(self) -> Frame:
        return self._keep({"type": "agent.clear", "session_id": self.id})

    def _tool(self, name: str, arguments: Frame | None = None) -> Frame:
        self._calls += 1
        frame: Frame = {"type": "tool.call", "session_id": self.id, "call_ref": f"t{self._calls}", "name": name}
        if arguments is not None:
            frame["arguments"] = arguments
        return self._keep(frame)

    def _keep(self, frame: Frame) -> Frame:
        """Counts a frame as sent, and keeps it while it is among the latest RETAINED_FRAMES."""
        self._kept.append(frame)
        if len(self._kept) > RETAINED_FRAMES:
            self._kept.pop(0)
            self._before += 1
        return frame
