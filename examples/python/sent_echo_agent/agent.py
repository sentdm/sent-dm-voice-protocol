"""A dial-in echo agent on the Sent Voice Agents protocol, written on the raw protocol with no SDK. It connects
to Sent with the account API key, greets a text session and says back the caller's latest line, acts on a few
spoken commands with the built-in tools, sends an audio session's audio back as it is, answers heartbeats, and
keeps its sessions through a drain or a lost connection with session.resume. session.py holds what happens
inside one session. This module holds the connections."""

from __future__ import annotations

import asyncio
import json
import os
import re
import signal
import sys
from dataclasses import dataclass, field
from datetime import UTC, datetime
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from .audio import stream_of
from .session import Frame, Session, latest_line, pong

SUBPROTOCOL = "sent.voice.v1"
DEFAULT_URL = "wss://voice.sent.dm/v1/agents/connect"
# The longest wait before another attempt to connect.
MAX_BACKOFF_S = 30.0
# How long a handshake may take before the attempt counts as failed.
HANDSHAKE_TIMEOUT_S = 10.0
# Why Sent refuses a handshake with each status, from Connecting in docs/protocol.md. Each needs a person.
REFUSALS = {
    400: "agent_id or the sent.voice.v1 subprotocol is missing",
    401: "the API key is not valid",
    403: "voice is not enabled for the account, or the key does not own the agent",
    404: "the agent does not exist",
}


def log(event: str, *details: object) -> None:
    stamp = datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    print(stamp, event, *[detail for detail in details if detail != ""], flush=True)


@dataclass(frozen=True)
class Config:
    api_key: str
    agent_id: str
    url: str
    transfer_to: str | None


@dataclass(eq=False)
class Connection:
    """One WebSocket to Sent, and the sessions it reads and writes."""

    # Sessions to resume here once Sent is ready.
    pending: list[Session]
    socket: ClientConnection | None = None
    # Sent sent connection.ready, so the connection carries sessions.
    ready: bool = False
    # Sent sent connection.draining, so a new connection took this one's place for new calls.
    draining: bool = False
    # The sessions on this connection, by id.
    sessions: dict[str, Session] = field(default_factory=dict)
    # Sessions with a session.resume sent here that Sent has not answered yet.
    resuming: set[str] = field(default_factory=set)
    heartbeat_s: float = 0.0
    task: asyncio.Task[None] | None = None


class EchoAgent:
    def __init__(self, config: Config) -> None:
        self._config = config
        self._connections: set[Connection] = set()
        # Every live session, by id.
        self._sessions: dict[str, Session] = {}
        self._attempt = 0
        self._stopped = False
        self._done: asyncio.Future[int] | None = None

    async def run(self) -> int:
        """Serves calls until stop(), or a refusal that needs a person. Returns the exit code."""
        self._done = asyncio.get_running_loop().create_future()
        self._open([], 0.0)
        try:
            return await self._done
        finally:
            await self._close_all()

    def stop(self) -> None:
        self._finish(0)

    def _finish(self, code: int) -> None:
        if self._done is not None and not self._done.done():
            log("stopping")
            self._done.set_result(code)

    async def _close_all(self) -> None:
        """Closes every connection with 1000: the agent is done with its calls, so they follow fallback at once."""
        self._stopped = True
        tasks = []
        for connection in list(self._connections):
            if connection.socket is not None:
                await connection.socket.close(1000)
            elif connection.task is not None:
                connection.task.cancel()
            if connection.task is not None:
                tasks.append(connection.task)
        await asyncio.gather(*tasks, return_exceptions=True)

    def _open(self, pending: list[Session], delay: float) -> None:
        """Opens a connection after `delay`, and resumes `pending` on it once Sent is ready."""
        connection = Connection(pending)
        self._connections.add(connection)
        connection.task = asyncio.create_task(self._serve(connection, delay))

    async def _serve(self, connection: Connection, delay: float) -> None:
        await asyncio.sleep(delay)
        parts = urlsplit(self._config.url)
        query = urlencode([*parse_qsl(parts.query), ("agent_id", self._config.agent_id)])
        url = urlunsplit(parts._replace(query=query))
        try:
            async with connect(
                url,
                subprotocols=[SUBPROTOCOL],  # type: ignore[list-item]
                additional_headers={"Authorization": f"Bearer {self._config.api_key}"},
                open_timeout=HANDSHAKE_TIMEOUT_S,
                # A dead connection gets no close handshake, so give up on one fast and resume elsewhere.
                close_timeout=1.0,
            ) as socket:
                connection.socket = socket
                log("connected", parts.netloc)
                await self._read(connection, socket)
        except InvalidStatus as refusal:
            status = refusal.response.status_code
            log("refused", status, REFUSALS.get(status, "trying again"))
            if status in REFUSALS:
                self._finish(1)
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - a failed attempt is logged and tried again
            log("connection failed", f"{type(error).__name__}: {error}")
        finally:
            self._closed(connection)

    async def _read(self, connection: Connection, socket: ClientConnection) -> None:
        while True:
            # No frame for three heartbeat intervals means the connection is dead.
            timeout = 3 * connection.heartbeat_s if connection.ready else None
            try:
                message = await asyncio.wait_for(socket.recv(), timeout)
            except TimeoutError:
                log("silent", f"no frame for {timeout:.0f} s, closing")
                return
            except ConnectionClosed as closed:
                close = closed.rcvd or closed.sent
                log("closed", close.code if close else 1006, close.reason if close else "")
                return
            if isinstance(message, bytes):
                await self._echo_audio(connection, socket, message)
                continue
            try:
                frame = json.loads(message)
            except ValueError:
                log("not JSON", "ignored")
                continue
            await self._handle(connection, frame)

    async def _handle(self, connection: Connection, frame: Frame) -> None:
        match frame.get("type"):
            case "connection.ready":
                await self._ready(connection, frame)
            case "ping":
                await self._send(connection, pong(frame))
            case "connection.draining":
                self._drain(connection)
            case "session.start":
                await self._start_session(connection, frame)
            case "session.resumed":
                await self._resumed(connection, frame)
            case "error":
                self._error(connection, frame)
            case _:
                await self._read_session_frame(connection, frame)

    async def _ready(self, connection: Connection, frame: Frame) -> None:
        connection.ready = True
        connection.heartbeat_s = frame["heartbeat_interval_ms"] / 1000
        self._attempt = 0
        # A pending session may have ended, on its old connection, while this one opened.
        pending = [session for session in connection.pending if self._sessions.get(session.id) is session]
        connection.pending = []
        log(
            "ready",
            f"protocol {frame['protocol_version']}",
            f"up to {frame['max_sessions']} sessions",
            f"resuming {len(pending)}" if pending else "",
        )
        for session in pending:
            await self._resume(connection, session)

    async def _resume(self, connection: Connection, session: Session) -> None:
        """Moves a session here. From now on it is read and written on this connection only: Sent replays here
        what its old connection did not deliver, and drops what still reaches the old one."""
        for other in self._connections:
            other.sessions.pop(session.id, None)
        connection.sessions[session.id] = session
        connection.resuming.add(session.id)
        await self._send(connection, session.resume_frame())
        log("session.resume", session.id, f"read {session.received} of Sent's frames")

    def _drain(self, connection: Connection) -> None:
        connection.draining = True
        moving = [
            session
            for session in connection.sessions.values()
            if session.token and session.id not in connection.resuming
        ]
        log("draining", f"moving {len(moving)} session(s)" if moving else "no session to move")
        # The new connection takes new calls, and the sessions move once Sent is ready on it. Sent closes this
        # one with 1001 when no session is left on it.
        self._open(moving, 0.0)

    async def _start_session(self, connection: Connection, frame: Frame) -> None:
        session = Session(frame, self._config.transfer_to)
        self._sessions[session.id] = session
        connection.sessions[session.id] = session
        sender = frame["from"].get("value", frame["from"]["kind"])
        log(
            "session.start",
            session.id,
            frame["session_type"],
            f"{frame['direction']} from {sender}",
            f"resumable for {frame['resume']['window_ms']} ms" if "resume" in frame else "not resumable",
            f"stream {frame['audio']['stream']} at {session.sample_rate} Hz" if "audio" in frame else "",
        )
        await self._send_all(connection, session.greeting())

    async def _read_session_frame(self, connection: Connection, frame: Frame) -> None:
        session = connection.sessions.get(frame.get("session_id", ""))
        # A session that moved to another connection is read there: Sent replays what this one did not deliver.
        if session is None:
            return
        answers = session.read(frame)
        match frame["type"]:
            case "user.said":
                text = json.dumps(latest_line(frame["text"]))
                log("user.said", session.id, text, "correction" if frame.get("correction") else "")
            case "tool.result":
                error = frame.get("error") or {}
                outcome = "ok" if frame["ok"] else f"{error.get('code')}: {error.get('message')}"
                log("tool.result", session.id, frame["call_ref"], outcome)
            case "session.end":
                echoed = f"{session.audio_frames} audio frames sent back" if session.audio_frames else ""
                log("session.end", session.id, frame["reason"], f"{frame['duration_ms']} ms", echoed)
            case _:
                # A frame type this sample does not know. It was counted, and that is all.
                log("frame", frame["type"], session.id, "ignored")
        await self._send_all(connection, answers)
        if frame["type"] == "session.end":
            self._forget(session)

    async def _resumed(self, connection: Connection, frame: Frame) -> None:
        session = connection.sessions.get(frame["session_id"])
        if session is None or session.id not in connection.resuming:
            return
        connection.resuming.discard(session.id)
        again = session.resumed(frame)
        log(
            "session.resumed",
            session.id,
            f"Sent read {frame['received']} of the agent's frames",
            f"sending {len(again)} again" if "resume" in frame else "ended while detached, its replay follows",
            f"stream {frame['audio']['stream']}" if "audio" in frame else "",
        )
        await self._send_all(connection, again)

    def _error(self, connection: Connection, frame: Frame) -> None:
        error = frame["error"]
        log("error", error["code"], error["message"], frame.get("session_id", ""), frame.get("frame_type", ""))
        session_id = frame.get("session_id")
        if not session_id or session_id not in connection.resuming:
            return
        # The answer to a session.resume.
        connection.resuming.discard(session_id)
        session = connection.sessions.pop(session_id, None)
        if session is None:
            return
        # This connection already carries max_sessions. The token is still good on another one.
        if error["code"] == "connection_full":
            self._open([session], 0.0)
            return
        # resume_failed, or anything else: the session is over, as if it ended with agent_unreachable.
        self._forget(session)

    async def _echo_audio(self, connection: Connection, socket: ClientConnection, frame: bytes) -> None:
        """Sends an audio session's frame back as it is, on the same stream."""
        if len(frame) < 2:
            return
        stream = stream_of(frame)
        for session in connection.sessions.values():
            if session.stream != stream or session.id in connection.resuming:
                continue
            if session.audio_frames == 0:
                log("audio", session.id, f"stream {stream}", f"{len(frame) - 2} bytes per frame")
            session.audio_frames += 1
            try:
                await socket.send(frame)
            except ConnectionClosed:
                pass
            return

    def _forget(self, session: Session) -> None:
        self._sessions.pop(session.id, None)
        for connection in self._connections:
            connection.sessions.pop(session.id, None)

    def _closed(self, connection: Connection) -> None:
        if connection not in self._connections:
            return
        self._connections.discard(connection)
        if self._stopped:
            return

        def queued(session: Session) -> bool:
            return any(session in other.pending for other in self._connections)

        lost = list(connection.sessions.values())
        # A session moves with its token, unless its resume is waiting for an answer: Sent may have spent it.
        movable = [
            session
            for session in lost
            if session.token and session.id not in connection.resuming and not queued(session)
        ]
        for session in lost:
            if session in movable or queued(session):
                continue
            log("session lost", session.id, "its resume was not answered" if session.token else "it has no resume token")
            self._forget(session)
        # Sessions this connection never got to resume are still waiting, within their window.
        pending = [s for s in connection.pending if self._sessions.get(s.id) is s] + movable
        if connection.draining and not pending:
            return
        delay = self._backoff()
        ids = ", ".join(session.id for session in pending)
        log("reconnecting", f"in {delay:g} s", f"to resume {ids}" if pending else "")
        self._open(pending, delay)

    def _backoff(self) -> float:
        """At once the first time, then 1, 2, 4 seconds and so on, up to MAX_BACKOFF_S. Reset by connection.ready."""
        delay = 0.0 if self._attempt == 0 else min(MAX_BACKOFF_S, float(2 ** (self._attempt - 1)))
        self._attempt += 1
        return delay

    async def _send(self, connection: Connection, frame: Frame) -> None:
        try:
            if connection.socket is None:
                raise ConnectionClosed(None, None)
            await connection.socket.send(json.dumps(frame))
        except ConnectionClosed:
            # A session frame is still counted as sent. Sent's received on the next resume says to send it again.
            log("not sent", frame["type"], "the connection is not open")

    async def _send_all(self, connection: Connection, frames: list[Frame]) -> None:
        for frame in frames:
            await self._send(connection, frame)


def _required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        print(f"{name} is not set", file=sys.stderr)
        raise SystemExit(1)
    return value


def main() -> int:
    transfer_to = os.environ.get("TRANSFER_TO") or None
    if transfer_to and not re.fullmatch(r"\+[1-9][0-9]{6,14}", transfer_to):
        print("TRANSFER_TO must be an E.164 number, such as +14155550123", file=sys.stderr)
        return 1
    config = Config(
        api_key=_required("SENT_API_KEY"),
        agent_id=_required("SENT_AGENT_ID"),
        url=os.environ.get("SENT_VOICE_URL") or DEFAULT_URL,
        transfer_to=transfer_to,
    )
    agent = EchoAgent(config)

    async def serve() -> int:
        loop = asyncio.get_running_loop()
        for signum in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(signum, agent.stop)
        return await agent.run()

    return asyncio.run(serve())
