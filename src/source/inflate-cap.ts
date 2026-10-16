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

/**
 * Inflates each deflate chunk of a bare fig-kiwi blob under a shared `cap` and discards the result,
 * so a decompression bomb fails here instead of exhausting memory in the reader. Other chunk codecs
 * and malformed blobs are left for the reader.
 */
function checkKiwiChunks(blob: Buffer, cap: number, over: () => never): void {
  if (blob.length < KIWI_HEADER || blob.toString("latin1", 0, KIWI_MAGIC.length) !== KIWI_MAGIC) return;
  let remaining = cap;
  for (let at = KIWI_HEADER; at + 4 <= blob.length; ) {
    const size = blob.readUInt32LE(at);
    at += 4;
    if (at + size > blob.length) return;
    const out = inflateCapped(blob.subarray(at, at + size), remaining, over);
    if (out) {
      remaining -= out.length;
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
