import { getNode } from "../compile/query.js";
import type { CompiledDocument, CompiledNode } from "../compile/types.js";
import type { ControlledProp } from "../gates/tok.js";
import type { PenFill } from "../pen/types.js";
import { solidColor } from "../pen/paint.js";
import { isVariableRef } from "../render/themes.js";

/** A literal (not `$variable`) value found in a controlled property. */
export interface Slot {
  /** Dotted path inside the node's props, e.g. `stroke.fill` or `fill[1].color`. */
  prop: string;
  controlled: ControlledProp;
  kind: "color" | "number" | "string";
  value: string | number;
}

/** Most entries read from one list or object, so untrusted values stay cheap. */
const MAX_ENTRIES = 16;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const sorted = (o: Record<string, unknown>): string[] => Object.keys(o).sort().slice(0, MAX_ENTRIES);

function colorSlot(value: unknown, path: string, controlled: ControlledProp): Slot[] {
  const list = Array.isArray(value) ? value : [value];
  let index = -1;
  list.forEach((p, i) => {
    if (typeof p === "string" || (isObject(p) && p.enabled !== false)) index = i;
  });
  const color = solidColor(value as PenFill);
  if (index < 0 || color === undefined || isVariableRef(undefined, color)) return [];
  const entry = list[index];
  const prop = `${Array.isArray(value) ? `${path}[${index}]` : path}${typeof entry === "string" ? "" : ".color"}`;
  return [{ prop, controlled, kind: "color", value: color }];
}

function numberSlots(value: unknown, path: string, controlled: ControlledProp): Slot[] {
  const one = (v: unknown, prop: string): Slot[] => (typeof v === "number" && Number.isFinite(v) ? [{ prop, controlled, kind: "number", value: v }] : []);
  if (Array.isArray(value)) return value.slice(0, MAX_ENTRIES).flatMap((v, i) => one(v, `${path}[${i}]`));
  if (isObject(value)) return sorted(value).flatMap((k) => one(value[k], `${path}.${k}`));
  return one(value, path);
}

function strokeSlots(stroke: unknown, enabled: ReadonlySet<ControlledProp>): Slot[] {
  const out: Slot[] = [];
  const list = Array.isArray(stroke) ? stroke.slice(0, MAX_ENTRIES) : [stroke];
  list.forEach((s, i) => {
    const at = Array.isArray(stroke) ? `stroke[${i}]` : "stroke";
    if (typeof s === "string") {
      if (enabled.has("stroke")) out.push(...colorSlot(s, at, "stroke"));
    } else if (isObject(s) && s.enabled !== false) {
      if (enabled.has("stroke")) out.push(...colorSlot(s.fill, `${at}.fill`, "stroke"));
      if (enabled.has("strokeWidth")) out.push(...numberSlots(s.thickness, `${at}.thickness`, "strokeWidth"));
    }
  });
  return out;
}

/**
 * Literal values in the controlled properties of a node. Accepted shapes: `fill` is a string, a paint
 * object or a list of either (the top solid paint counts); `stroke` a colour string or an object with
 * `fill` and `thickness` (or a list); `effect` an object with `color` or a list. Other shapes are skipped.
 */
export function literalSlots(node: CompiledNode, enabled: ReadonlySet<ControlledProp>): Slot[] {
  const p = node.props;
  const out: Slot[] = [];
  if (enabled.has("fill")) out.push(...colorSlot(p.fill, "fill", "fill"));
  if (enabled.has("stroke") || enabled.has("strokeWidth")) out.push(...strokeSlots(p.stroke, enabled));
  if (enabled.has("strokeWidth")) out.push(...numberSlots(p.strokeWidth, "strokeWidth", "strokeWidth"));
  if (enabled.has("effect.color")) {
    const list = Array.isArray(p.effect) ? p.effect.slice(0, MAX_ENTRIES) : [p.effect];
    list.forEach((e, i) => {
      if (isObject(e) && e.enabled !== false) out.push(...colorSlot(e.color, Array.isArray(p.effect) ? `effect[${i}].color` : "effect.color", "effect.color"));
    });
  }
  for (const key of ["cornerRadius", "gap", "padding", "fontSize"] as const) {
    if (enabled.has(key)) out.push(...numberSlots(p[key], key, key));
  }
  if (enabled.has("fontFamily") && typeof p.fontFamily === "string" && p.fontFamily !== "" && !isVariableRef(undefined, p.fontFamily)) {
    out.push({ prop: "fontFamily", controlled: "fontFamily", kind: "string", value: p.fontFamily });
  }
  return out;
}

/** The own prop a dotted path starts with. */
export const rootProp = (path: string): string => path.split(/[.[]/)[0] ?? "";

/** A literal copied from a reusable component is reported on the component, not on each instance copy. */
export const isInherited = (node: CompiledNode, slot: Slot): boolean => node.provenance[rootProp(slot.prop)]?.origin === "component";

/** Sorted ids of the instances whose copies carry the literal `prop` of component node `sourceId`. */
export function affectedInstances(compiled: CompiledDocument, slots: readonly { node: CompiledNode; slot: Slot }[]): Map<string, string[]> {
  const found = new Map<string, Set<string>>();
  for (const { node, slot } of slots) {
    const prov = node.provenance[rootProp(slot.prop)];
    if (prov?.origin !== "component") continue;
    const key = `${prov.sourceNodeId}\0${slot.prop}`;
    const set = found.get(key) ?? new Set<string>();
    for (const id of [...node.parents, node.id]) if (getNode(compiled, id)?.instanceOf !== undefined) set.add(id);
    found.set(key, set);
  }
  return new Map([...found].map(([k, v]) => [k, [...v].sort()]));
}

/** `sourceNodeId\0prop` key for looking up `affectedInstances`. */
export const affectedKey = (node: CompiledNode, slot: Slot): string => `${node.id}\0${slot.prop}`;
