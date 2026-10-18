import { getNode, listInstances } from "../compile/query.js";
import type { CompiledDocument, CompiledNode } from "../compile/types.js";
import type { Tok001Config } from "../gates/config.js";
import { isIgnored, MAX_IGNORE_LENGTH, normalizeColor, type ControlledProp } from "../gates/tok.js";
import { solidColor } from "../pen/paint.js";
import type { PenFill } from "../pen/types.js";
import { isVariableRef, resolveAlias } from "../render/themes.js";

/** A literal (not `$variable`) value found in a controlled property. */
export interface Slot {
  /** Dotted/indexed path inside the node's props, e.g. `stroke.fill`, `fill[1].color` or `padding[0]`. */
  prop: string;
  controlled: ControlledProp;
  kind: "color" | "number" | "string";
  value: string | number;
}

/** Most entries read from one list, so untrusted values stay cheap. */
const MAX_ENTRIES = 16;
const SIDES = ["top", "right", "bottom", "left"] as const;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The literal colour `solidColor` finds in `value`; `nested` is appended to `prop` when the colour sits in a paint object. */
function colorSlot(value: unknown, prop: string, controlled: ControlledProp, nested = ""): Slot[] {
  const color = solidColor(value as PenFill);
  if (color === undefined || isVariableRef(undefined, color)) return [];
  let at = prop;
  if (Array.isArray(value)) {
    let index = -1;
    value.forEach((p, i) => {
      if (typeof p === "string" || (isObject(p) && p.enabled !== false)) index = i;
    });
    at = `${prop}[${index}]`;
    if (isObject(value[index])) at += nested;
  } else if (isObject(value)) at += nested;
  return [{ prop: at, controlled, kind: "color", value: color }];
}

function numberSlot(value: unknown, prop: string, controlled: ControlledProp): Slot[] {
  return isNumber(value) ? [{ prop, controlled, kind: "number", value }] : [];
}

/** A number, or a list of `lengths` numbers (checked element by element). */
function numbersOrList(value: unknown, prop: string, controlled: ControlledProp, lengths: readonly number[]): Slot[] {
  if (!Array.isArray(value)) return numberSlot(value, prop, controlled);
  if (!lengths.includes(value.length)) return [];
  return value.flatMap((v, i) => numberSlot(v, `${prop}[${i}]`, controlled));
}

function thicknessSlots(value: unknown, prop: string): Slot[] {
  if (!isObject(value)) return numberSlot(value, prop, "strokeWidth");
  return SIDES.flatMap((side) => numberSlot(value[side], `${prop}.${side}`, "strokeWidth"));
}

function strokeSlots(stroke: unknown, enabled: ReadonlySet<ControlledProp>): Slot[] {
  const list = Array.isArray(stroke) ? stroke.slice(0, MAX_ENTRIES) : [stroke];
  return list.flatMap((s, i) => {
    const at = Array.isArray(stroke) ? `stroke[${i}]` : "stroke";
    if (typeof s === "string") return enabled.has("stroke") ? colorSlot(s, at, "stroke") : [];
    if (!isObject(s) || s.enabled === false) return [];
    const out: Slot[] = [];
    if (enabled.has("stroke")) out.push(...("fill" in s ? colorSlot(s.fill, `${at}.fill`, "stroke") : colorSlot(s, at, "stroke", ".color")));
    if (enabled.has("strokeWidth")) out.push(...thicknessSlots(s.thickness, `${at}.thickness`));
    return out;
  });
}

/**
 * Literal values in the controlled properties of a node. `fill` goes through `solidColor`; `stroke` is a
 * colour string, a PenStroke (`fill` colour, `thickness` number or per-side object) or a list of them;
 * `effect` is one PenEffect or a list, read through `color`. Other shapes are skipped.
 */
export function literalSlots(node: CompiledNode, enabled: ReadonlySet<ControlledProp>): Slot[] {
  const p = node.props;
  const out: Slot[] = [];
  if (enabled.has("fill")) out.push(...colorSlot(p.fill, "fill", "fill", ".color"));
  if (enabled.has("stroke") || enabled.has("strokeWidth")) out.push(...strokeSlots(p.stroke, enabled));
  if (enabled.has("strokeWidth")) out.push(...thicknessSlots(p.strokeWidth, "strokeWidth"));
  if (enabled.has("effect.color")) {
    const list = Array.isArray(p.effect) ? p.effect.slice(0, MAX_ENTRIES) : [p.effect];
    list.forEach((e, i) => {
      if (isObject(e) && e.enabled !== false) out.push(...colorSlot(e.color, Array.isArray(p.effect) ? `effect[${i}].color` : "effect.color", "effect.color"));
    });
  }
  if (enabled.has("cornerRadius")) out.push(...numbersOrList(p.cornerRadius, "cornerRadius", "cornerRadius", [4]));
  if (enabled.has("padding")) out.push(...numbersOrList(p.padding, "padding", "padding", [2, 4]));
  if (enabled.has("gap")) out.push(...numberSlot(p.gap, "gap", "gap"));
  if (enabled.has("fontSize")) out.push(...numberSlot(p.fontSize, "fontSize", "fontSize"));
  if (enabled.has("fontFamily") && typeof p.fontFamily === "string" && p.fontFamily !== "" && !isVariableRef(undefined, p.fontFamily)) {
    out.push({ prop: "fontFamily", controlled: "fontFamily", kind: "string", value: p.fontFamily });
  }
  return out;
}

/** The own prop a dotted path starts with. */
export const rootProp = (path: string): string => path.split(/[.[]/)[0] ?? "";

/** A literal copied from a reusable component is reported on the component definition, not on each instance copy. */
export const isInherited = (node: CompiledNode, slot: Slot): boolean => node.provenance[rootProp(slot.prop)]?.origin === "component";

/** Sorted instances of the reusable component enclosing `node` (itself included), or undefined when there are none. */
export function affectedInstances(compiled: CompiledDocument, node: CompiledNode): string[] | undefined {
  const chain = [node, ...[...node.parents].reverse().map((id) => getNode(compiled, id))];
  const component = chain.find((n) => n !== undefined && !n.expanded && n.props.reusable === true);
  const ids = component ? listInstances(compiled, component.id) : [];
  return ids.length ? ids : undefined;
}

/** Controlled properties whose findings block (TOK-001 and TOK-005 share this). */
export const TOK_BLOCKING: ReadonlySet<ControlledProp> = new Set(["fill", "stroke", "effect.color", "fontSize"]);

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Lookup key of a value among variable values: colours compare normalised and case-insensitively. */
export function valueKey(slot: Pick<Slot, "kind" | "value">): string | undefined {
  if (slot.kind === "number") return typeof slot.value === "number" ? `n:${slot.value}` : undefined;
  if (typeof slot.value !== "string") return undefined;
  const color = normalizeColor(slot.value);
  return slot.kind === "color" ? (color ? `c:${color}` : undefined) : `s:${slot.value}`;
}

/** Variable names (`$name`, sorted) per value key, resolved in the given theme. */
export function variableIndex(compiled: CompiledDocument, theme: CompiledNode["theme"]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const name of Object.keys(compiled.variables).sort(cmp)) {
    const r = resolveAlias(`$${name}`, compiled.variables, theme);
    if (r.status !== "ok") continue;
    const value = r.value;
    const keys =
      typeof value === "number"
        ? [`n:${value}`]
        : typeof value === "string"
          ? [normalizeColor(value) ? `c:${normalizeColor(value)}` : `s:${value}`]
          : [];
    for (const key of keys) index.set(key, [...(index.get(key) ?? []), `$${name}`]);
  }
  return index;
}

export const globToRegExp = (glob: string): RegExp => new RegExp(`^${glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);

/** The `onlyIn` / `ignoreValues` options of TOK-001: true when a slot is not excluded by them. */
export function tok001Filter(compiled: CompiledDocument, cfg: Pick<Tok001Config, "onlyIn" | "ignoreValues">): (node: CompiledNode, slot: Slot) => boolean {
  const only = cfg.onlyIn.map(globToRegExp);
  const inScope = (node: CompiledNode): boolean => {
    if (!only.length) return true;
    const top = getNode(compiled, node.topFrameId);
    const names = [top?.id, top?.sourceId, typeof top?.props.name === "string" ? top.props.name : undefined];
    return names.some((n) => n !== undefined && only.some((re) => re.test(n.slice(0, MAX_IGNORE_LENGTH))));
  };
  return (node, slot) => inScope(node) && !isIgnored(slot.value, Object.hasOwn(cfg.ignoreValues, slot.controlled) ? cfg.ignoreValues[slot.controlled] ?? [] : []);
}
