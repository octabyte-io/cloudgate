/**
 * The text of a `docker service logs` answer.
 *
 * A container started without a TTY — every Swarm task Cloudgate creates —
 * answers its logs **multiplexed**: each chunk is an 8-byte header (the
 * stream, 1 for stdout and 2 for stderr, three zero bytes, then the chunk's
 * length as a big-endian 32-bit number) followed by that many bytes. Read as
 * text, the headers would put control bytes into the Deployment log, so they
 * are taken off here and the chunks joined in order. An answer that is not
 * framed so (a TTY's) is returned as it is. Pure.
 */
export function demuxDockerLogs(raw: Buffer): string {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < raw.length) {
    if (!isFrameHeader(raw, offset)) return raw.toString('utf8');
    const size = raw.readUInt32BE(offset + 4);
    const start = offset + 8;
    chunks.push(raw.subarray(start, Math.min(start + size, raw.length)));
    offset = start + size;
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isFrameHeader(raw: Buffer, offset: number): boolean {
  return (
    offset + 8 <= raw.length &&
    raw[offset] <= 2 &&
    raw[offset + 1] === 0 &&
    raw[offset + 2] === 0 &&
    raw[offset + 3] === 0
  );
}
