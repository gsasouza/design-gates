import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export const DEFAULT_THRESHOLD = 0.1;

export interface PixelDiff {
  width: number;
  height: number;
  /** Changed pixels / total pixels, rounded to 6 decimals. */
  ratio: number;
  /** One byte per pixel of the common canvas; 1 = changed. */
  mask: Uint8Array;
  /** PNG: changed pixels highlighted over a dimmed copy of the base. */
  diffPng: Buffer;
}

export interface PixelDiffOptions {
  threshold?: number;
}

/** Decoded RGBA pixels of `png`, placed top-left on a transparent `width` x `height` canvas. */
export function padToCanvas(png: Buffer, width: number, height: number): Uint8Array {
  const src = PNG.sync.read(png);
  if (src.width > width || src.height > height) throw new Error("Canvas is smaller than the image");
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < src.height; y++) {
    const row = src.data.subarray(y * src.width * 4, (y + 1) * src.width * 4);
    out.set(row, y * width * 4);
  }
  return out;
}

/** Diff colour: the only output pixels with a zero green channel (dimmed base pixels are never below ~229). */
const DIFF_COLOR: [number, number, number] = [255, 0, 0];

/**
 * Pixelmatch of `base` against `head` (either may be absent: it is then a transparent canvas)
 * after padding both onto the larger common canvas. Anti-aliased pixels are detected and ignored.
 */
export function pixelDiff(base: Buffer | undefined, head: Buffer | undefined, opts: PixelDiffOptions = {}): PixelDiff {
  const sizeOf = (b: Buffer | undefined): { width: number; height: number } => {
    if (!b) return { width: 0, height: 0 };
    const { width, height } = PNG.sync.read(b);
    return { width, height };
  };
  const bs = sizeOf(base);
  const hs = sizeOf(head);
  const width = Math.max(bs.width, hs.width);
  const height = Math.max(bs.height, hs.height);
  if (width === 0 || height === 0) throw new Error("Cannot diff two empty images");

  const a = base ? padToCanvas(base, width, height) : new Uint8Array(width * height * 4);
  const b = head ? padToCanvas(head, width, height) : new Uint8Array(width * height * 4);
  const out = new PNG({ width, height });
  const changed = pixelmatch(a, b, out.data, width, height, {
    threshold: opts.threshold ?? DEFAULT_THRESHOLD,
    includeAA: false,
    diffColor: DIFF_COLOR,
    diffColorAlt: DIFF_COLOR,
  });

  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    const o = i * 4;
    if (out.data[o] === 255 && out.data[o + 1] === 0 && out.data[o + 2] === 0) mask[i] = 1;
  }
  return {
    width,
    height,
    ratio: Math.round((changed / (width * height)) * 1e6) / 1e6,
    mask,
    diffPng: PNG.sync.write(out),
  };
}
