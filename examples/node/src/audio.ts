// The binary audio frame of an audio session: a 2-byte big-endian stream number, then 16-bit little-endian
// mono PCM at the session's sample rate, a whole number of samples. This sample sends each frame it reads
// back as it is, so it only needs the stream. A production agent decodes the samples for its speech models
// and builds frames from its own audio with audioFrame.

/** The stream a frame belongs to: the session whose stream it is, on this connection. */
export const streamOf = (frame: Buffer): number => frame.readUInt16BE(0);

/** The samples of a frame, as 16-bit little-endian mono PCM. */
export const samplesOf = (frame: Buffer): Buffer => frame.subarray(2);

/** A frame carrying `samples` for `stream`. */
export function audioFrame(stream: number, samples: Buffer): Buffer {
  const frame = Buffer.alloc(2 + samples.length);
  frame.writeUInt16BE(stream, 0);
  samples.copy(frame, 2);
  return frame;
}
