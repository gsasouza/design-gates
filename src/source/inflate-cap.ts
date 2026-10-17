import { decodeMessage, initCodec } from "@open-pencil/core";
import { Decompress } from "fzstd";
import { inflateRawSync } from "node:zlib";
import type { NodeChange } from "../fig/guids.js";

const ZIP_CENTRAL_MAGIC = 0x02014b50;
const ZIP_END_MAGIC = 0x06054b50;
const KIWI_MAGIC = "fig-kiwi";
const KIWI_HEADER = KIWI_MAGIC.length + 4;

/** Inflates raw deflate data, returning null when it is not deflate and throwing `over` when it passes `cap`. */
function inflateCapped(data: Buffer, cap: number, over: () => never): Buffer | null {
  try {
    return inflateRawSync(data, { maxOutputLength: Math.max(cap, 1) });
  } catch (err) {
    if ((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") return over();
    return null;
  }
}

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const ZSTD_SKIPPABLE_MASK = 0xfffffff0;
const ZSTD_SKIPPABLE_MAGIC = 0x184d2a50;

const isZstd = (chunk: Uint8Array): boolean => ZSTD_MAGIC.every((b, i) => chunk[i] === b);

/**
 * Refuses (through `over`) any frame of a zstd stream whose declared content size or window size
 * is past `cap`. fzstd allocates `content size || window size` up front, even when streaming, so
 * the output count alone does not bound memory. Throws a plain error when the stream is malformed.
 */
function checkZstdHeaders(chunk: Uint8Array, cap: number, over: () => never): void {
  const view = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const malformed = (): never => {
    throw new Error("malformed zstd data");
  };
  let at = 0;
  while (at < view.length) {
    if (at + 4 > view.length) malformed();
    if (((view.readUInt32LE(at) & ZSTD_SKIPPABLE_MASK) >>> 0) === ZSTD_SKIPPABLE_MAGIC) {
      if (at + 8 > view.length) malformed();
      at += 8 + view.readUInt32LE(at + 4);
      continue;
    }
    if (!isZstd(view.subarray(at))) malformed();
    const descriptor = view[at + 4];
    if (descriptor === undefined) return malformed();
    const sizeFlag = descriptor >> 6;
    const single = (descriptor >> 5) & 1;
    const dictBytes = [0, 1, 2, 4][descriptor & 3]!;
    const sizeBytes = sizeFlag === 0 ? single : 1 << sizeFlag;
    let p = at + 5;
    let window = 0;
    if (!single) {
      const byte = view[p++];
      if (byte === undefined) return malformed();
      const base = 2 ** (10 + (byte >> 3));
      window = base + (base / 8) * (byte & 7);
    }
    p += dictBytes;
    if (p + sizeBytes > view.length) malformed();
    let size = 0;
    if (sizeBytes === 1) size = view[p]!;
    else if (sizeBytes === 2) size = view.readUInt16LE(p) + 256;
    else if (sizeBytes === 4) size = view.readUInt32LE(p);
    else if (sizeBytes === 8) size = Number(view.readBigUInt64LE(p));
    if (single) window = size;
    if (size > cap || window > cap) over();
    p += sizeBytes;
    for (let last = false; !last; ) {
      if (p + 3 > view.length) malformed();
      const header = view.readUIntLE(p, 3);
      last = (header & 1) === 1;
      const type = (header >> 1) & 3;
      if (type === 3) malformed();
      p += 3 + (type === 1 ? 1 : header >> 3);
    }
    at = p + ((descriptor >> 2) & 1) * 4;
  }
}

/** Streams a zstd chunk through fzstd, counting output and calling `over` once it passes `cap`. */
function zstdCapped(chunk: Uint8Array, cap: number, over: () => never): Uint8Array {
  checkZstdHeaders(chunk, cap, over);
  const parts: Uint8Array[] = [];
  let total = 0;
  const stream = new Decompress((data) => {
    total += data.length;
    if (total > cap) over();
    parts.push(data);
  });
  stream.push(chunk, true);
  return Buffer.concat(parts);
}

/**
 * Decompresses one fig-kiwi chunk under `cap`: zstd is streamed with a running output count (the
 * declared sizes only gate the up-front allocation), deflate is inflated with an output limit.
 * Malformed zstd throws. Returns null for a chunk that is neither zstd nor raw deflate: it is left to
 * the reader's own decoder, never decoded here.
 */
export function decompressChunkCapped(chunk: Uint8Array, cap: number, over: () => never): Uint8Array | null {
  if (isZstd(chunk)) return zstdCapped(chunk, cap, over);
  return inflateCapped(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength), cap, over);
}

/** Replaceable steps of the capped pass, so tests can count how often each one runs. */
export interface InflateSeams {
  decompress?: typeof decompressChunkCapped;
  decode?: (data: Uint8Array) => { nodeChanges?: NodeChange[] };
}

/**
 * Inflates each chunk of a bare fig-kiwi blob under a shared `cap` and discards it, so a
 * decompression bomb fails here instead of exhausting memory in the reader. With `wanted`, the data
 * chunk (the second) is decoded right after its decompression and only the node changes are kept.
 * Malformed blobs are left for the reader.
 */
async function checkKiwiChunks(blob: Buffer, cap: number, over: () => never, seams: InflateSeams, wanted: boolean): Promise<NodeChange[] | undefined> {
  if (blob.length < KIWI_HEADER || blob.toString("latin1", 0, KIWI_MAGIC.length) !== KIWI_MAGIC) return undefined;
  const decompress = seams.decompress ?? decompressChunkCapped;
  let remaining = cap;
  let changes: NodeChange[] | undefined;
  for (let at = KIWI_HEADER, index = 0; at + 4 <= blob.length; index++) {
    const size = blob.readUInt32LE(at);
    at += 4;
    if (at + size > blob.length) return changes;
    // A chunk that is neither zstd nor raw deflate yields null: only parseFigFile ever sees it.
    const out = decompress(blob.subarray(at, at + size), remaining, over);
    if (out) {
      remaining -= out.length;
      if (remaining < 0) over();
      if (wanted && index === 1) {
        await initCodec();
        changes = ((seams.decode ?? decodeMessage)(out) as { nodeChanges?: NodeChange[] }).nodeChanges ?? [];
      }
    }
    at += size;
  }
  return changes;
}

/**
 * Applies the chunk cap to a bare fig-kiwi blob, or to every archive entry (stored or deflated) of a
 * zipped one, and returns the node changes decoded from the data chunk of the bare blob or of the
 * `canvas.fig` entry (undefined when there is none or it cannot be read).
 */
export async function checkKiwiInflation(bytes: Buffer, cap: number, over: () => never, seams: InflateSeams = {}): Promise<NodeChange[] | undefined> {
  if (bytes.toString("latin1", 0, KIWI_MAGIC.length) === KIWI_MAGIC) return checkKiwiChunks(bytes, cap, over, seams, true);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (bytes.readUInt32LE(i) === ZIP_END_MAGIC) {
      end = i;
      break;
    }
  }
  if (end < 0) return undefined;
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  let budget = cap;
  let changes: NodeChange[] | undefined;
  for (let n = 0; n < count && offset + 46 <= bytes.length; n++) {
    if (bytes.readUInt32LE(offset) !== ZIP_CENTRAL_MAGIC) return changes;
    const method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20);
    const local = bytes.readUInt32LE(offset + 42);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
    if (local + 30 > bytes.length) continue;
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const raw = bytes.subarray(start, start + compressed);
    const entry = method === 0 ? raw : method === 8 ? inflateCapped(raw, budget, over) : null;
    if (!entry) continue;
    budget -= method === 8 ? entry.length : 0;
    if (budget < 0) over();
    const found = await checkKiwiChunks(entry, cap, over, seams, name === "canvas.fig" && changes === undefined);
    changes ??= found;
  }
  return changes;
}
