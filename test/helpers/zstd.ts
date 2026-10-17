const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** A zstd block header: the 21 bit size, the block type (0 raw, 1 RLE) and the last-block flag. */
const blockHeader = (size: number, type: number, last: boolean): Buffer => Buffer.from([(size << 3) | (type << 1) | (last ? 1 : 0), (size >> 5) & 0xff, (size >> 13) & 0xff]);

/** A zstd frame header: window descriptor 0x50 (1 MiB window), with the content size declared in four bytes or left out. */
function frameHeader(declared: number | undefined): Buffer {
  if (declared === undefined) return Buffer.concat([MAGIC, Buffer.from([0x00, 0x50])]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(declared);
  return Buffer.concat([MAGIC, Buffer.from([0x80, 0x50]), size]);
}

/** A valid frame holding `data` in raw blocks, stating the content size in its header only when `declare` is set. */
export function rawZstdFrame(data: Uint8Array, declare: boolean): Buffer {
  const blocks: Buffer[] = [];
  for (let at = 0; at < data.length || at === 0; at += 0x10000) {
    const part = data.subarray(at, at + 0x10000);
    blocks.push(blockHeader(part.length, 0, at + 0x10000 >= data.length), Buffer.from(part));
  }
  return Buffer.concat([frameHeader(declare ? data.length : undefined), ...blocks]);
}

/**
 * A frame that declares 256 bytes (a four byte size field) yet expands to `blocks` RLE blocks of
 * 64 KiB each, then ends in a corrupt compressed block: only a decoder that stops counting output
 * early never reaches the corruption.
 */
export function rleBombFrame(blocks: number): Buffer {
  const parts: Buffer[] = [frameHeader(256)];
  for (let i = 0; i < blocks; i++) parts.push(blockHeader(0x10000, 1, false), Buffer.from([0x61]));
  parts.push(blockHeader(4, 2, true), Buffer.from([0xde, 0xad, 0xbe, 0xef]));
  return Buffer.concat(parts);
}

/** A bare fig-kiwi blob (the version word of `like`) whose chunks are the given payloads. */
export function kiwiBlobOf(like: Buffer, chunks: Buffer[]): Buffer {
  const parts: Buffer[] = [like.subarray(0, 12)];
  for (const chunk of chunks) {
    const size = Buffer.alloc(4);
    size.writeUInt32LE(chunk.length);
    parts.push(size, chunk);
  }
  return Buffer.concat(parts);
}
