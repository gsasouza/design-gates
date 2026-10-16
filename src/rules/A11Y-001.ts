import { themeKey } from "../diff/variables.js";
import { getNode, resolveForTheme } from "../compile/query.js";
import type { CompiledDocument, CompiledNode } from "../compile/types.js";
import type { GatesConfig } from "../gates/config.js";
import type { Rule, Violation } from "../gates/types.js";
import { gradientStops, solidColor } from "../pen/paint.js";
import type { PenFill } from "../pen/types.js";
import type { Theme } from "../render/themes.js";
import { composite, contrastRatio, isLargeText, parseColor, withOpacity, type Rgba } from "./a11y/color.js";

const ID = "A11Y-001";
/** Most theme combinations evaluated per text node. */
const MAX_COMBINATIONS = 16;
/** Most distinct background candidates tracked while compositing gradients. */
const MAX_BACKGROUNDS = 256;
const MAX_STOPS = 16;
const MAX_ANCESTORS = 256;

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

type Paint = { kind: "none" } | { kind: "solid"; colors: Rgba[] } | { kind: "unknown" };

/** True unless the fill is missing, empty, or has only disabled entries. */
function hasVisiblePaint(fill: unknown): boolean {
  if (fill === undefined || fill === null) return false;
  const list = Array.isArray(fill) ? fill : [fill];
  return list.some((p) => (typeof p === "string" ? true : isObject(p) && p.enabled !== false));
}

function resolveValue(compiled: CompiledDocument, value: unknown, theme: Theme): unknown {
  if (typeof value !== "string" || !value.startsWith("$")) return value;
  const r = resolveForTheme(compiled, value, theme);
  return r.status === "ok" ? r.value : undefined;
}

/** Colours a fill takes in a theme (one for solid, one per stop for gradients), or unknown when it cannot be evaluated. */
function paintOf(compiled: CompiledDocument, fill: unknown, theme: Theme): Paint {
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

function numberProp(compiled: CompiledDocument, node: CompiledNode, prop: string, theme: Theme, fallback: number): number {
  const v = resolveValue(compiled, node.props[prop], theme);
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

function ancestorsOf(compiled: CompiledDocument, node: CompiledNode): CompiledNode[] {
  const out: CompiledNode[] = [];
  for (const id of [...node.parents].reverse().slice(0, MAX_ANCESTORS)) {
    const a = getNode(compiled, id);
    if (a) out.push(a);
  }
  return out;
}

/** Theme axes pinned by the node or an ancestor. */
function pinnedAxes(chain: CompiledNode[]): Set<string> {
  const pinned = new Set<string>();
  for (const n of chain) if (isObject(n.props.theme)) for (const k of Object.keys(n.props.theme)) pinned.add(k);
  return pinned;
}

/**
 * The first 2 * MAX_COMBINATIONS (sorted; the second half only feeds the bounded skipped listing) combinations of the unpinned axes' values with the node's
 * pinned values, plus the arithmetic total; the product itself is never materialised.
 */
export function nodeCombinations(compiled: CompiledDocument, node: CompiledNode, chain: CompiledNode[]): { combos: { key: string; theme: Theme }[]; total: number } {
  const pinned = pinnedAxes(chain);
  const axes = Object.entries(compiled.themes)
    .map(([axis, values]) => [axis, Array.isArray(values) ? [...new Set(values.filter((v): v is string => typeof v === "string"))].sort(byString) : []] as const)
    .filter(([axis, values]) => values.length > 0 && !pinned.has(axis))
    .sort(([a], [b]) => byString(a, b));
  const total = axes.reduce((n, [, values]) => n * values.length, 1);
  const combos: { key: string; theme: Theme }[] = [];
  // odometer over the sorted axes: the last axis varies fastest, which is the sorted key order
  const index = axes.map(() => 0);
  for (let n = 0; n < Math.min(total, 2 * MAX_COMBINATIONS); n++) {
    const theme: Theme = { ...node.theme };
    axes.forEach(([axis, values], i) => (theme[axis] = values[index[i]!]!));
    combos.push({ theme, key: themeKey(theme) });
    for (let i = axes.length - 1; i >= 0; i--) {
      if (++index[i]! < axes[i]![1].length) break;
      index[i] = 0;
    }
  }
  return { combos: combos.sort((a, b) => byString(a.key, b.key)), total };
}

type Outcome = { kind: "review"; message: string } | { kind: "ratio"; ratio: number; min: number };

interface Evaluation {
  outcome: Outcome;
  /** Ancestors (nearest first) that took part in the result. */
  used: CompiledNode[];
  /** The background chain reached an opaque fill. */
  closed: boolean;
}

function evaluate(compiled: CompiledDocument, config: GatesConfig, text: CompiledNode, chain: CompiledNode[], theme: Theme): Evaluation | undefined {
  const own = paintOf(compiled, text.props.fill, theme);
  if (own.kind === "none") return undefined;
  const review = (message: string): Evaluation => ({ outcome: { kind: "review", message }, used: chain, closed: false });
  if (own.kind === "unknown") return review("text color cannot be evaluated; review contrast manually");

  // accumulated opacity of the node and each ancestor, from the node upward
  const opacity = [text, ...chain].map((n) => numberProp(compiled, n, "opacity", theme, 1));
  const above = (i: number): number => opacity.slice(i).reduce((a, b) => a * b, 1);

  // layers outermost last; stop at the first opaque one
  const layers: Rgba[][] = [];
  const used: CompiledNode[] = [];
  let closed = false;
  for (const [i, a] of chain.entries()) {
    const paint = paintOf(compiled, a.props.fill, theme);
    if (paint.kind === "none") continue;
    used.push(a);
    if (paint.kind === "unknown") return { ...review("background has an image, shader or unsupported fill; contrast cannot be computed"), used };
    const factor = above(i + 1);
    const colors = paint.colors.map((c) => withOpacity(c, factor));
    layers.push(colors);
    if (colors.every((c) => c.a >= 1)) {
      closed = true;
      break;
    }
  }

  const canvas = parseColor(config.canvasColor) ?? { r: 255, g: 255, b: 255, a: 1 };
  let backgrounds: Rgba[] = [{ ...canvas, a: 1 }];
  for (const layer of layers.reverse()) {
    const next = new Map<string, Rgba>();
    for (const c of layer) for (const b of backgrounds) {
      const out = composite(c, b);
      next.set(`${out.r},${out.g},${out.b}`, out);
    }
    backgrounds = [...next.values()].slice(0, MAX_BACKGROUNDS);
  }

  const fontSize = numberProp(compiled, text, "fontSize", theme, 16);
  const fontWeight = numberProp(compiled, text, "fontWeight", theme, 400);
  const large = isLargeText(fontSize, fontWeight);
  const rule = config.rules[ID];
  const min = large ? rule.minRatioLarge : rule.minRatio;
  const textOpacity = above(0);
  let worst = Infinity;
  for (const color of own.colors) {
    const fg = withOpacity(color, textOpacity);
    for (const bg of backgrounds) worst = Math.min(worst, contrastRatio(composite(fg, bg), bg));
  }
  return { outcome: { kind: "ratio", ratio: worst, min }, used, closed };
}

const fromComponent = (n: CompiledNode, prop: string): boolean => n.provenance[prop] === undefined || n.provenance[prop]!.origin === "component";

/** True when the text colour, every background fill and every opacity come from the component itself. */
function selfContained(compiled: CompiledDocument, text: CompiledNode, chain: CompiledNode[], ev: Evaluation): boolean {
  if (!text.expanded || !ev.closed) return false;
  const rootIndex = chain.findIndex((a) => a.instanceOf !== undefined);
  if (rootIndex < 0) return false;
  const inside = [text, ...chain.slice(0, rootIndex + 1)];
  if (!inside.every((n) => fromComponent(n, "fill") && fromComponent(n, "opacity"))) return false;
  if (!ev.used.every((a) => inside.includes(a))) return false;
  return chain.slice(rootIndex + 1).every((a) => a.props.opacity === undefined || a.props.opacity === 1);
}

/** The component definition node this expanded node was copied from. */
function definitionOf(compiled: CompiledDocument, node: CompiledNode): CompiledNode | undefined {
  let cur: CompiledNode | undefined = node;
  for (let i = 0; i < 64 && cur?.expanded; i++) cur = cur.source === undefined ? undefined : getNode(compiled, cur.source);
  return cur && !cur.expanded ? cur : undefined;
}

export const runA11y001: Rule = (compiled, config) => {
  const out: Violation[] = [];
  const attach = new Map<string, Set<string>>();
  const pending: { key: string; v: Violation; instance: string }[] = [];

  for (const text of compiled.nodes) {
    if (text.type !== "text") continue;
    const chain = ancestorsOf(compiled, text);
    const { combos: generated, total } = nodeCombinations(compiled, text, [text, ...chain]);
    const evaluated = generated.slice(0, MAX_COMBINATIONS);
    const skipped = generated.slice(MAX_COMBINATIONS);
    const base = { rule: ID, file: compiled.file, nodeId: text.id, path: text.path };
    if (total > MAX_COMBINATIONS) {
      out.push({
        ...base,
        severity: "info",
        fixedSeverity: true,
        message: `${ID} evaluated ${evaluated.length} of ${total} theme combinations; evaluated: [${evaluated.map((c) => c.key).join(", ")}]; skipped: [${skipped.map((c) => c.key).join(", ")}]${total - evaluated.length > skipped.length ? ` and ${total - evaluated.length - skipped.length} more` : ""}`,
      });
    }
    let reviewed = false;
    for (const combo of evaluated) {
      const ev = evaluate(compiled, config, text, chain, combo.theme);
      if (!ev) continue;
      if (ev.outcome.kind === "review") {
        if (reviewed) continue;
        reviewed = true;
        out.push({ ...base, severity: "review", fixedSeverity: true, prop: "fill", message: ev.outcome.message });
        continue;
      }
      const { ratio, min } = ev.outcome;
      if (ratio >= min) continue;
      const v: Violation = { ...base, severity: "block", prop: "fill", message: `contrast ${ratio.toFixed(2)}:1 < ${min}:1`, theme: combo.key };
      if (selfContained(compiled, text, chain, ev)) {
        const def = definitionOf(compiled, text);
        const instance = [...chain].reverse().find((a) => !a.expanded && a.instanceOf !== undefined);
        if (def && instance) {
          pending.push({ key: `${def.id}\u0000${combo.key}\u0000${v.message}`, v, instance: instance.id });
          continue;
        }
      }
      out.push(v);
    }
  }

  // report component-owned results once, on the component, with the instances they affect
  const reported = new Map<string, Violation>();
  for (const v of out) if (v.theme !== undefined) reported.set(`${v.nodeId}\u0000${v.theme}\u0000${v.message}`, v);
  for (const p of pending) {
    const target = reported.get(p.key);
    if (!target) {
      out.push(p.v);
      continue;
    }
    const set = attach.get(p.key) ?? new Set<string>();
    set.add(p.instance);
    attach.set(p.key, set);
  }
  for (const [key, ids] of attach) {
    const target = reported.get(key)!;
    target.affectedInstances = [...ids].sort(byString);
  }
  return out;
};
