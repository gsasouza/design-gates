import { getNode, resolveForTheme } from "../../compile/query.js";
import type { CompiledDocument, CompiledNode } from "../../compile/types.js";
import { gradientStops, solidColor } from "../../pen/paint.js";
import type { PenFill } from "../../pen/types.js";
import type { Theme } from "../../render/themes.js";
import { parseColor, type Rgba } from "./color.js";

const MAX_STOPS = 16;
const MAX_ANCESTORS = 256;

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export type Paint = { kind: "none" } | { kind: "solid"; colors: Rgba[] } | { kind: "unknown" };

/** True unless the fill is missing, empty, or has only disabled entries. */
export function hasVisiblePaint(fill: unknown): boolean {
  if (fill === undefined || fill === null) return false;
  const list = Array.isArray(fill) ? fill : [fill];
  return list.some((p) => (typeof p === "string" ? true : isObject(p) && p.enabled !== false));
}

export function resolveValue(compiled: CompiledDocument, value: unknown, theme: Theme): unknown {
  if (typeof value !== "string" || !value.startsWith("$")) return value;
  const r = resolveForTheme(compiled, value, theme);
  return r.status === "ok" ? r.value : undefined;
}

/** Colours a fill takes in a theme (one for solid, one per stop for gradients), or unknown when it cannot be evaluated. */
export function paintOf(compiled: CompiledDocument, fill: unknown, theme: Theme): Paint {
  if (!hasVisiblePaint(fill)) return { kind: "none" };
  const parse = (raw: string): Rgba | undefined => parseColor(resolveValue(compiled, raw, theme));
  const solid = solidColor(fill as PenFill);
  if (solid !== undefined) {
    const c = parse(solid);
    return c ? { kind: "solid", colors: [c] } : { kind: "unknown" };
  }
  const stops = gradientStops(fill as PenFill);
  if (stops && stops.length > 0) {
    const colors = stops.slice(0, MAX_STOPS).map((s) => parse(s.color));
    return colors.every((c): c is Rgba => c !== undefined) ? { kind: "solid", colors } : { kind: "unknown" };
  }
  return { kind: "unknown" };
}

export function numberProp(compiled: CompiledDocument, node: CompiledNode, prop: string, theme: Theme, fallback: number): number {
  const v = resolveValue(compiled, node.props[prop], theme);
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

/** The node's ancestors, nearest first (bounded). */
export function ancestorsOf(compiled: CompiledDocument, node: CompiledNode): CompiledNode[] {
  const out: CompiledNode[] = [];
  for (const id of [...node.parents].reverse().slice(0, MAX_ANCESTORS)) {
    const a = getNode(compiled, id);
    if (a) out.push(a);
  }
  return out;
}

/** Accumulated opacity of `[text, ...chain]` from index `i` upward (`above(0)` is the text's own). */
export function opacityAbove(compiled: CompiledDocument, text: CompiledNode, chain: CompiledNode[], theme: Theme): (i: number) => number {
  const opacity = [text, ...chain].map((n) => numberProp(compiled, n, "opacity", theme, 1));
  return (i) => opacity.slice(i).reduce((a, b) => a * b, 1);
}

/**
 * The background walk shared by A11Y-001 and A11Y-004: visits the ancestors nearest first (only ancestor
 * fills are walked, not siblings) with the opacity accumulated above each; the visitor returns true to stop.
 */
export function walkBackground(chain: CompiledNode[], above: (i: number) => number, visit: (ancestor: CompiledNode, factor: number) => boolean | void): void {
  for (const [i, a] of chain.entries()) if (visit(a, above(i + 1)) === true) break;
}
