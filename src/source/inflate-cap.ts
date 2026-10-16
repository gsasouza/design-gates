import { decompressFigKiwiDataAsync } from "@open-pencil/core";
import { inflateRawSync } from "node:zlib";

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
 * The total content size a zstd stream declares in its frame headers, or undefined when a frame
 * leaves it out or the stream is malformed (then nothing bounds what the decoder would produce).
 */
function zstdDeclaredSize(chunk: Uint8Array): number | undefined {
  const view = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  let total = 0;
  let at = 0;
  while (at < view.length) {
    if (at + 4 > view.length) return undefined;
    const magic = view.readUInt32LE(at);
    if ((magic & ZSTD_SKIPPABLE_MASK) >>> 0 === ZSTD_SKIPPABLE_MAGIC) {
      at += 8 + view.readUInt32LE(at + 4);
      continue;
    }
    if (!isZstd(view.subarray(at))) return undefined;
    const descriptor = view[at + 4];
    if (descriptor === undefined) return undefined;
    const sizeFlag = descriptor >> 6;
    const single = (descriptor >> 5) & 1;
    const dictBytes = [0, 1, 2, 4][descriptor & 3]!;
    const sizeBytes = sizeFlag === 0 ? single : 1 << sizeFlag;
    if (sizeBytes === 0) return undefined;
    let p = at + 5 + (single ? 0 : 1) + dictBytes;
    if (p + sizeBytes > view.length) return undefined;
    const size = sizeBytes === 1 ? view[p]! : sizeBytes === 2 ? view.readUInt16LE(p) + 256 : sizeBytes === 4 ? view.readUInt32LE(p) : Number(view.readBigUInt64LE(p));
    total += size;
    p += sizeBytes;
    for (let last = false; !last; ) {
      if (p + 3 > view.length) return undefined;
      const header = view.readUIntLE(p, 3);
      last = (header & 1) === 1;
      const type = (header >> 1) & 3;
      if (type === 3) return undefined;
      p += 3 + (type === 1 ? 1 : header >> 3);
    }
    at = p + ((descriptor >> 2) & 1) * 4;
  }
  return total;
}

/**
 * Decompresses one fig-kiwi chunk under `cap`: deflate is inflated with an output limit, and zstd
 * (decoded by the reader's fzstd) must declare a content size within the cap. Anything else is left
 * to the reader's own decoder.
 */
export async function decompressChunkCapped(chunk: Uint8Array, cap: number, over: () => never): Promise<Uint8Array> {
  if (isZstd(chunk)) {
    const size = zstdDeclaredSize(chunk);
    if (size === undefined || size > cap) over();
  } else {
    const out = inflateCapped(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength), cap, over);
    if (out) return out;
  }
  return decompressFigKiwiDataAsync(chunk);
}

/**
 * Checks each chunk of a bare fig-kiwi blob under a shared `cap`: deflate chunks are inflated and
 * discarded, zstd chunks must declare a content size (an undeclared size is rejected, since nothing
 * bounds it), so a decompression bomb fails here instead of exhausting memory in the reader.
 * Malformed blobs are left for the reader.
 */
function checkKiwiChunks(blob: Buffer, cap: number, over: () => never): void {
  if (blob.length < KIWI_HEADER || blob.toString("latin1", 0, KIWI_MAGIC.length) !== KIWI_MAGIC) return;
  let remaining = cap;
  for (let at = KIWI_HEADER; at + 4 <= blob.length; ) {
    const size = blob.readUInt32LE(at);
    at += 4;
    if (at + size > blob.length) return;
    const chunk = blob.subarray(at, at + size);
    const declared = isZstd(chunk) ? (zstdDeclaredSize(chunk) ?? over()) : inflateCapped(chunk, remaining, over)?.length;
    if (declared !== undefined) {
      remaining -= declared;
      if (remaining < 0) over();
    }
    at += size;
  }
}

/** Applies the chunk cap to a bare fig-kiwi blob, or to every archive entry (stored or deflated) of a zipped one. */
export function checkKiwiInflation(bytes: Buffer, cap: number, over: () => never): void {
  if (bytes.toString("latin1", 0, KIWI_MAGIC.length) === KIWI_MAGIC) return checkKiwiChunks(bytes, cap, over);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (bytes.readUInt32LE(i) === ZIP_END_MAGIC) {
      end = i;
      break;
    }
  }
  if (end < 0) return;
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  let budget = cap;
  for (let n = 0; n < count && offset + 46 <= bytes.length; n++) {
    if (bytes.readUInt32LE(offset) !== ZIP_CENTRAL_MAGIC) return;
    const method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20);
    const local = bytes.readUInt32LE(offset + 42);
    offset += 46 + bytes.readUInt16LE(offset + 28) + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
    if (local + 30 > bytes.length) continue;
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const raw = bytes.subarray(start, start + compressed);
    const entry = method === 0 ? raw : method === 8 ? inflateCapped(raw, budget, over) : null;
    if (!entry) continue;
    budget -= method === 8 ? entry.length : 0;
    if (budget < 0) over();
    checkKiwiChunks(entry, cap, over);
  }
}
