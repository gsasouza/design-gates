import { themeCombinations } from "../compile/query.js";
import { resolveAlias } from "../render/themes.js";
import type { CompiledDocument, CompiledNode } from "../compile/types.js";
import type { GatesConfig, Tok002Scale } from "../gates/config.js";
import type { ControlledProp } from "../gates/tok.js";
import type { Violation } from "../gates/types.js";
import { affectedInstances, affectedKey, isInherited, literalSlots, rootProp, type Slot } from "./tok-slots.js";

const NUMERIC: ReadonlySet<ControlledProp> = new Set(["cornerRadius", "fontSize", "gap", "padding", "strokeWidth"]);
const CATEGORY: Partial<Record<ControlledProp, string>> = { cornerRadius: "radius", fontSize: "fontSize", gap: "spacing", padding: "spacing", strokeWidth: "strokeWidth" };
const EPS = 1e-9;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const round = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Nearest allowed value(s), ascending, or undefined when `value` is on the scale (within `tolerance`). */
export function offScale(value: number, scale: Tok002Scale, tolerance: number): number[] | undefined {
  let below: number;
  let above: number;
  if (Array.isArray(scale)) {
    const list = [...scale].sort((a, b) => a - b);
    if (!list.length) return undefined;
    below = [...list].reverse().find((n) => n <= value + EPS) ?? (list[0] as number);
    above = list.find((n) => n >= value - EPS) ?? (list.at(-1) as number);
  } else {
    below = Math.floor(value / scale.base + EPS) * scale.base;
    above = Math.ceil(value / scale.base - EPS) * scale.base;
  }
  below = round(below);
  above = round(above);
  const db = Math.abs(value - below);
  const da = Math.abs(above - value);
  if (Math.min(db, da) <= tolerance + EPS) return undefined;
  if (Math.abs(db - da) <= EPS && below !== above) return [below, above];
  return [db < da ? below : above];
}

/** Category of a variable use, from the property path it was found at. */
function useCategory(prop: string): string | undefined {
  const root = rootProp(prop);
  if (root === "stroke") return /(^|[.[\]])thickness([.[\]]|$)/.test(prop) ? "strokeWidth" : undefined;
  return CATEGORY[root as ControlledProp];
}

/** TOK-002: numeric values off the configured scales. */
export function run(compiled: CompiledDocument, config: GatesConfig): Violation[] {
  const cfg = config.rules["TOK-002"];
  const severity = config.strict ? ({ severity: "block", fixedSeverity: true } as const) : ({ severity: "warn" } as const);
  const out: Violation[] = [];

  const all: { node: CompiledNode; slot: Slot }[] = compiled.nodes.flatMap((node) => literalSlots(node, NUMERIC).map((slot) => ({ node, slot })));
  const affected = affectedInstances(compiled, all);
  for (const { node, slot } of all) {
    const category = CATEGORY[slot.controlled];
    const scale = category ? cfg.scales[category] : undefined;
    if (!category || !scale || typeof slot.value !== "number" || isInherited(node, slot)) continue;
    const near = offScale(slot.value, scale, cfg.tolerance);
    if (!near) continue;
    const instances = affected.get(affectedKey(node, slot));
    out.push({
      rule: "TOK-002",
      ...severity,
      file: compiled.file,
      nodeId: node.id,
      path: node.path,
      prop: slot.prop,
      message: `${slot.controlled} ${slot.value} is off the ${category} scale; nearest: ${near.join(", ")}`,
      fix: { type: "candidates", prop: slot.prop, candidates: near },
      ...(instances?.length ? { affectedInstances: instances } : {}),
    });
  }

  // Values resolved through a variable are reported once, on the variable definition, for every theme combination.
  const used = new Map<string, { ref: string; category: string }>();
  for (const node of compiled.nodes) {
    for (const use of node.uses) {
      const category = useCategory(use.prop);
      if (category && use.chain[0] !== undefined) used.set(`${use.chain[0]}\0${category}`, { ref: `$${use.chain[0]}`, category });
    }
  }
  const combos = themeCombinations(compiled.themes);
  const seen = new Map<string, Violation>();
  for (const { ref, category } of used.values()) {
    const scale = cfg.scales[category];
    if (!scale) continue;
    for (const combo of combos) {
      const r = resolveAlias(ref, compiled.variables, combo.theme);
      const name = r.chain.at(-1);
      if (r.status !== "ok" || name === undefined || typeof r.value !== "number" || !Number.isFinite(r.value)) continue;
      const near = offScale(r.value, scale, cfg.tolerance);
      if (!near) continue;
      const key = `${name}\0${category}\0${r.value}`;
      if (seen.has(key)) continue;
      seen.set(key, {
        rule: "TOK-002",
        ...severity,
        file: compiled.file,
        nodeId: `$${name}`,
        path: `variables/${name}`,
        prop: "value",
        message: `Variable $${name} = ${r.value} is off the ${category} scale; nearest: ${near.join(", ")}`,
        fix: { type: "candidates", prop: "value", candidates: near },
        ...(Object.keys(combo.theme).length ? { theme: combo.key } : {}),
      });
    }
  }
  out.push(...seen.values());
  return out.sort((a, b) => cmp(a.nodeId, b.nodeId) || cmp(a.prop ?? "", b.prop ?? "") || cmp(a.message, b.message));
}
