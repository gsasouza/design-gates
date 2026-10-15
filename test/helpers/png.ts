import { PNG } from "pngjs";
import type { Renderer } from "../../src/index.js";
import type { PenDocument } from "../../src/index.js";

export type Rgba = [number, number, number, number];

/** Solid `color` PNG of `w` x `h`; `paint` may then set individual pixels. */
export function makePng(w: number, h: number, color: Rgba, paint?: (set: (x: number, y: number, c: Rgba) => void) => void): Buffer {
  const png = new PNG({ width: w, height: h });
  const set = (x: number, y: number, c: Rgba): void => {
    png.data.set(c, (y * w + x) * 4);
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) set(x, y, color);
  paint?.(set);
  return PNG.sync.write(png);
}

export function fillRect(set: (x: number, y: number, c: Rgba) => void, x: number, y: number, w: number, h: number, c: Rgba): void {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) set(i, j, c);
}

export const WHITE: Rgba = [255, 255, 255, 255];
export const BLACK: Rgba = [0, 0, 0, 255];

export interface FakeRender {
  png: Buffer;
  width: number;
  height: number;
  nodeBoxes: Record<string, { x: number; y: number; w: number; h: number }>;
}

export interface FakeCall {
  frameId: string;
  scale: number;
  theme?: Record<string, string>;
}

/** Renderer returning canned renders chosen by (document, frame id, theme key); records its calls. */
export function fakeRenderer(pick: (doc: PenDocument, frameId: string, theme?: Record<string, string>) => FakeRender): Renderer & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  return {
    calls,
    async renderFrame(doc, frameId, opts) {
      calls.push({ frameId, scale: opts.scale, ...(opts.theme && { theme: opts.theme }) });
      return pick(doc, frameId, opts.theme);
    },
  };
}

export function render(png: Buffer, nodeBoxes: FakeRender["nodeBoxes"] = {}): FakeRender {
  const { width, height } = PNG.sync.read(png);
  return { png, width, height, nodeBoxes };
}
