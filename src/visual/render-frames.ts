import { createHash } from "node:crypto";
import type { ThemeKey, DiffDocs, DiffResult, FrameDiff, FrameImages } from "../diff/model.js";
import type { PenDocument } from "../pen/types.js";
import type { Renderer } from "../render/renderer.js";
import { pixelDiff, type PixelDiff } from "./pixel-diff.js";
import type { Boxes } from "./change-boxes.js";

export type Theme = Record<string, string>;

export interface ThemedRender {
  key: ThemeKey;
  base?: { png: Buffer; boxes: Boxes };
  head?: { png: Buffer; boxes: Boxes };
  diff: PixelDiff;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Filesystem-safe form of `text`: anything outside [A-Za-z0-9._-] becomes "-". */
export function sanitize(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}

/** Deterministic, collision-free directory name for a file path: sanitized path + first 8 hex of sha256(path). */
export function fileSlug(path: string): string {
  return `${sanitize(path)}-${createHash("sha256").update(path).digest("hex").slice(0, 8)}`;
}

/** "default", or "axis=value" pairs sorted by axis and joined with ",". */
export function themeKeyOf(theme: Theme | undefined): ThemeKey {
  const pairs = Object.entries(theme ?? {}).sort(([a], [b]) => cmp(a, b));
  return pairs.length ? pairs.map(([k, v]) => `${k}=${v}`).join(",") : "default";
}

export function parseThemeKey(key: ThemeKey): Theme | undefined {
  if (key === "default") return undefined;
  return Object.fromEntries(
    key.split(",").map((pair) => {
      const i = pair.indexOf("=");
      return [pair.slice(0, i), pair.slice(i + 1)];
    }),
  );
}

/** Whether the frame is rendered: it changed, or a variable/theme change lists it. */
export function isRenderable(result: DiffResult, file: string, frame: FrameDiff): boolean {
  if (frame.status !== "unchanged") return true;
  return listed(result, file, frame, [...result.variables, ...result.themes]);
}

function listed(result: DiffResult, file: string, frame: FrameDiff, changes: { file: string; frames: { file: string; frameId: string }[] }[]): boolean {
  const ids = new Set([frame.id, frame.baseId, frame.headId]);
  return changes.some((c) => c.frames.some((f) => f.file === file && ids.has(f.frameId)));
}

/** Theme keys to render: "default" first, then the theme of every variable change listing the frame. */
export function themeKeysFor(result: DiffResult, file: string, frame: FrameDiff): ThemeKey[] {
  const keys = new Set<ThemeKey>(["default"]);
  if (!frame.baseId || !frame.headId) return [...keys];
  for (const v of result.variables) {
    if (!v.theme || v.theme === "default" || !listed(result, file, frame, [v])) continue;
    keys.add(themeKeyOf(parseThemeKey(v.theme)));
  }
  return [...keys].sort((a, b) => (a === "default" ? -1 : b === "default" ? 1 : cmp(a, b)));
}

async function renderSide(
  renderer: Renderer,
  doc: PenDocument | undefined,
  id: string | undefined,
  scale: number,
  theme: Theme | undefined,
): Promise<{ png: Buffer; boxes: Boxes } | undefined> {
  if (!doc || !id) return undefined;
  const r = await renderer.renderFrame(doc, id, theme ? { scale, theme } : { scale });
  return { png: r.png, boxes: r.nodeBoxes };
}

/** Render `frame` at base and/or head for every theme key and diff each pair on a common canvas. */
export async function renderFrameThemes(opts: {
  renderer: Renderer;
  docs: DiffDocs[string] | undefined;
  frame: FrameDiff;
  keys: ThemeKey[];
  scale: number;
  threshold?: number;
}): Promise<ThemedRender[]> {
  const { renderer, docs, frame, keys, scale } = opts;
  const out: ThemedRender[] = [];
  for (const key of keys) {
    const theme = parseThemeKey(key);
    const base = await renderSide(renderer, docs?.base, frame.baseId ?? (frame.status === "added" ? undefined : frame.id), scale, theme);
    const head = await renderSide(renderer, docs?.head, frame.headId ?? (frame.status === "removed" ? undefined : frame.id), scale, theme);
    if (!base && !head) continue;
    out.push({ key, ...(base && { base }), ...(head && { head }), diff: pixelDiff(base?.png, head?.png, { threshold: opts.threshold }) });
  }
  return out;
}

/** Relative image paths (under the output dir) for each theme key; only existing sides get one. */
export function imagePaths(file: string, frameId: string, renders: ThemedRender[]): { images: NonNullable<FrameImages>; files: Map<string, Buffer> } {
  const images: NonNullable<FrameImages> = {};
  const files = new Map<string, Buffer>();
  const dir = `images/${fileSlug(file)}`;
  for (const r of renders) {
    const stem = r.key === "default" ? sanitize(frameId) : `${sanitize(frameId)}-${sanitize(r.key)}`;
    const entry: { base?: string; head?: string; diff?: string } = {};
    const put = (kind: "base" | "head" | "diff", png: Buffer): void => {
      const p = `${dir}/${stem}-${kind}.png`;
      entry[kind] = p;
      files.set(p, png);
    };
    if (r.base) put("base", r.base.png);
    if (r.head) put("head", r.head.png);
    put("diff", r.diff.diffPng);
    images[r.key] = entry;
  }
  return { images, files };
}
