"""The binary audio frame of an audio session: a 2-byte big-endian stream number, then 16-bit little-endian
mono PCM at the session's sample rate, a whole number of samples. This sample sends each frame it reads back as
it is, so it only needs the stream. A production agent decodes the samples for its speech models and builds
frames from its own audio with audio_frame."""


def stream_of(frame: bytes) -> int:
    """The stream a frame belongs to: the session whose stream it is, on this connection."""
    return int.from_bytes(frame[:2], "big")


def samples_of(frame: bytes) -> bytes:
    """The samples of a frame, as 16-bit little-endian mono PCM."""
    return frame[2:]


def audio_frame(stream: int, samples: bytes) -> bytes:
    """A frame carrying `samples` for `stream`."""
    return stream.to_bytes(2, "big") + samples
