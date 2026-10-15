import type { ChangeBox, NodeChange } from "../diff/model.js";

export type Boxes = Record<string, { x: number; y: number; w: number; h: number }>;

export const DEFAULT_MIN_AREA = 4;
/** A pixel region is dropped when a node box covers at least this share of it. */
const COVERED_SHARE = 0.5;

type Rect = { x: number; y: number; w: number; h: number };

/** Integer box containing `b` (floor of the origin, ceil of the far edge). */
function integral(b: Rect): Rect {
  const x = Math.floor(b.x);
  const y = Math.floor(b.y);
  return { x, y, w: Math.max(1, Math.ceil(b.x + b.w) - x), h: Math.max(1, Math.ceil(b.y + b.h) - y) };
}

const cmp = (a: string | number, b: string | number): number => (a < b ? -1 : a > b ? 1 : 0);

/** Deterministic order: y, x, w, h, kind, nodeId (then side and name as final tie-breakers). */
export function sortBoxes(boxes: ChangeBox[]): ChangeBox[] {
  return [...boxes].sort(
    (a, b) =>
      cmp(a.y, b.y) ||
      cmp(a.x, b.x) ||
      cmp(a.w, b.w) ||
      cmp(a.h, b.h) ||
      cmp(a.kind, b.kind) ||
      cmp(a.nodeId ?? "", b.nodeId ?? "") ||
      cmp(a.side, b.side) ||
      cmp(a.name ?? "", b.name ?? ""),
  );
}

/**
 * Boxes of the changed nodes: removed and moved-from nodes use base boxes; added, modified,
 * moved-to and reordered nodes use head boxes. A node the renderer gave no box for yields none and
 * is listed in `missing` (coordinates are never invented).
 */
export function nodeChangeBoxes(
  nodes: NodeChange[],
  baseBoxes: Boxes | undefined,
  headBoxes: Boxes | undefined,
): { boxes: ChangeBox[]; missing: string[] } {
  const boxes: ChangeBox[] = [];
  const missing = new Set<string>();
  const add = (n: NodeChange, side: "base" | "head", from: Boxes | undefined): void => {
    const b = from?.[n.id];
    if (!b) {
      missing.add(n.id);
      return;
    }
    boxes.push({ ...integral(b), kind: n.change, side, nodeId: n.id, name: n.name });
  };
  for (const n of nodes) {
    if (n.change === "removed") add(n, "base", baseBoxes);
    else if (n.change === "moved") {
      add(n, "base", baseBoxes);
      add(n, "head", headBoxes);
    } else add(n, "head", headBoxes);
  }
  return { boxes, missing: [...missing].sort(cmp) };
}

interface Region extends Rect {
  area: number;
}

/** 8-connected components of set pixels in `mask`, with their bounding boxes and pixel counts. */
function components(mask: Uint8Array, width: number, height: number): Region[] {
  const seen = new Uint8Array(mask.length);
  const out: Region[] = [];
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let x0 = width, y0 = height, x1 = 0, y1 = 0, area = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % width;
      const y = (i - x) / width;
      area++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const n = ny * width + nx;
          if (mask[n] && !seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }
    out.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, area });
  }
  return out;
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function union(a: Region, b: Region): Region {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
    area: a.area + b.area,
  };
}

/** Merge regions whose boxes overlap, transitively (union-find, re-checking the grown boxes until stable). */
function mergeOverlapping(regions: Region[]): Region[] {
  const parent = regions.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  const grown = [...regions];
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < regions.length; i++) {
      for (let j = i + 1; j < regions.length; j++) {
        const a = find(i);
        const b = find(j);
        if (a === b || !overlaps(grown[a]!, grown[b]!)) continue;
        parent[b] = a;
        grown[a] = union(grown[a]!, grown[b]!);
        changed = true;
      }
    }
  }
  return regions.flatMap((_, i) => (find(i) === i ? [grown[i]!] : []));
}

function coveredShare(region: Rect, box: Rect): number {
  const w = Math.min(region.x + region.w, box.x + box.w) - Math.max(region.x, box.x);
  const h = Math.min(region.y + region.h, box.y + box.h) - Math.max(region.y, box.y);
  return w > 0 && h > 0 ? (w * h) / (region.w * region.h) : 0;
}

export interface PixelBoxOptions {
  /** Components with fewer changed pixels than this are dropped. */
  minArea?: number;
}

/**
 * Boxes (kind "pixel", side "head") of the connected regions of changed pixels: tiny components
 * dropped, overlapping ones merged, and regions mostly covered by a node box left to that box.
 */
export function pixelChangeBoxes(
  mask: Uint8Array,
  width: number,
  height: number,
  nodeBoxes: ChangeBox[],
  opts: PixelBoxOptions = {},
): ChangeBox[] {
  const minArea = opts.minArea ?? DEFAULT_MIN_AREA;
  const regions = mergeOverlapping(components(mask, width, height).filter((r) => r.area >= minArea));
  return regions
    .filter((r) => !nodeBoxes.some((b) => coveredShare(r, b) >= COVERED_SHARE))
    .map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h, kind: "pixel" as const, side: "head" as const }));
}
