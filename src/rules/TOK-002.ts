import { themeCombinations } from "../compile/query.js";
import type { CompiledDocument } from "../compile/types.js";
import type { GatesConfig, Scale, ScaleCategory } from "../gates/config.js";
import type { ControlledProp } from "../gates/tok.js";
import type { Violation } from "../gates/types.js";
import { themeKey } from "../diff/variables.js";
import { resolveAlias } from "../render/themes.js";
import { affectedInstances, isInherited, literalSlots, rootProp } from "./tok-slots.js";

const NUMERIC: ReadonlySet<ControlledProp> = new Set(["cornerRadius", "fontSize", "gap", "padding", "strokeWidth"]);
const CATEGORY: Partial<Record<string, ScaleCategory>> = { cornerRadius: "radius", fontSize: "fontSize", gap: "spacing", padding: "spacing", strokeWidth: "strokeWidth" };
const EPS = 1e-9;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const round = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Nearest allowed value(s), ascending, or undefined when `value` is on the scale (within `tolerance`). */
export function offScale(value: number, scale: Scale, tolerance: number): number[] | undefined {
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
function useCategory(prop: string): ScaleCategory | undefined {
  const root = rootProp(prop);
  if (root === "stroke") return /(^|[.[\]])thickness([.[\]]|$)/.test(prop) ? "strokeWidth" : undefined;
  return CATEGORY[root];
}

/** Variables holding a literal number that a checked property reads, with the categories reading it (aliases followed). */
function checkedVariables(compiled: CompiledDocument): Map<string, Set<ScaleCategory>> {
  const heads = new Map<string, Set<ScaleCategory>>();
  const out = new Map<string, Set<ScaleCategory>>();
  const add = (name: string, category: ScaleCategory): void => {
    out.set(name, (out.get(name) ?? new Set()).add(category));
  };
  for (const node of compiled.nodes) {
    for (const use of node.uses) {
      const category = useCategory(use.prop);
      if (!category) continue;
      heads.set(use.name, (heads.get(use.name) ?? new Set()).add(category));
      const holder = use.chain.at(-1);
      if (use.status === "ok" && holder !== undefined) add(holder, category);
    }
  }
  const combos = themeCombinations(compiled.themes);
  for (const [name, categories] of heads) {
    for (const combo of combos) {
      const r = resolveAlias(`$${name}`, compiled.variables, combo.theme);
      const holder = r.chain.at(-1);
      if (r.status !== "ok" || holder === undefined) continue;
      for (const category of categories) add(holder, category);
    }
  }
  return out;
}

/** TOK-002: numeric values off the configured scales. */
export function run(compiled: CompiledDocument, config: GatesConfig): Violation[] {
  const cfg = config.rules["TOK-002"];
  const severity = config.strict ? ({ severity: "block", fixedSeverity: true } as const) : ({ severity: "warn" } as const);
  const out: Violation[] = [];

  for (const node of compiled.nodes) {
    for (const slot of literalSlots(node, NUMERIC)) {
      const category = CATEGORY[slot.controlled];
      const scale = category ? cfg.scales[category] : undefined;
      if (!category || !scale || typeof slot.value !== "number" || isInherited(node, slot)) continue;
      const near = offScale(slot.value, scale, cfg.tolerance);
      if (!near) continue;
      const instances = affectedInstances(compiled, node);
      out.push({
        rule: "TOK-002",
        ...severity,
        file: compiled.file,
        nodeId: node.id,
        path: node.path,
        prop: slot.prop,
        message: `${slot.controlled} ${slot.value} is off the ${category} scale; nearest: ${near.join(", ")}`,
        fix: { type: "candidates", prop: slot.prop, candidates: near },
        ...(instances ? { affectedInstances: instances } : {}),
      });
    }
  }

  // A value resolved through a variable is reported once, on the variable that holds it, per declared entry and category.
  for (const [name, categories] of checkedVariables(compiled)) {
    const variable = Object.hasOwn(compiled.variables, name) ? compiled.variables[name] : undefined;
    if (!variable) continue;
    const entries = Array.isArray(variable.value) ? (variable.value as { value?: unknown; theme?: Record<string, string> }[]) : [{ value: variable.value }];
    for (const category of [...categories].sort(cmp)) {
      const scale = cfg.scales[category];
      for (const entry of entries) {
        const value = entry?.value;
        if (typeof value !== "number" || !Number.isFinite(value)) continue;
        const near = scale ? offScale(value, scale, cfg.tolerance) : undefined;
        if (!near) continue;
        const theme = entry.theme && Object.keys(entry.theme).length ? themeKey(entry.theme) : undefined;
        out.push({
          rule: "TOK-002",
          ...severity,
          file: compiled.file,
          nodeId: `$${name}`,
          path: `variables/${name}`,
          prop: "value",
          message: `Variable $${name} = ${value} is off the ${category} scale; nearest: ${near.join(", ")}`,
          fix: { type: "candidates", prop: "value", candidates: near },
          ...(theme ? { theme } : {}),
        });
      }
    }
  }
  return out.sort((a, b) => cmp(a.nodeId, b.nodeId) || cmp(a.prop ?? "", b.prop ?? "") || cmp(a.message, b.message) || cmp(a.theme ?? "", b.theme ?? ""));
}
