import { resolveAlias } from "../render/themes.js";
import type { CompiledDocument, CompiledNode } from "../compile/types.js";
import { getNode } from "../compile/query.js";
import type { GatesConfig } from "../gates/config.js";
import { controlledProp, isIgnored, normalizeColor, type ControlledProp } from "../gates/tok.js";
import type { Fix, Violation } from "../gates/types.js";
import { affectedInstances, affectedKey, isInherited, literalSlots, type Slot } from "./tok-slots.js";

const BLOCKING: ReadonlySet<ControlledProp> = new Set(["fill", "stroke", "effect.color", "fontSize"]);

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const globToRegExp = (glob: string): RegExp => new RegExp(`^${glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);

/** Lookup key of a value among variable values: colours compare normalised and case-insensitively. */
function valueKey(slot: Pick<Slot, "kind" | "value">): string | undefined {
  if (slot.kind === "number") return typeof slot.value === "number" ? `n:${slot.value}` : undefined;
  if (typeof slot.value !== "string") return undefined;
  const color = normalizeColor(slot.value);
  return slot.kind === "color" ? (color ? `c:${color}` : undefined) : `s:${slot.value}`;
}

function variableIndex(compiled: CompiledDocument, theme: CompiledNode["theme"]): Map<string, string[]> {
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

function fixFor(slot: Slot, names: string[] | undefined): Fix | undefined {
  if (!names?.length) return undefined;
  return names.length === 1 ? { type: "replace", prop: slot.prop, value: names[0] } : { type: "candidates", prop: slot.prop, candidates: [...names] };
}

/** TOK-001: hard-coded values in properties that should use design tokens. */
export function run(compiled: CompiledDocument, config: GatesConfig): Violation[] {
  const cfg = config.rules["TOK-001"];
  const enabled = new Set(cfg.properties.flatMap((p) => controlledProp(p) ?? []));
  const only = cfg.onlyIn.map(globToRegExp);
  const inScope = (node: CompiledNode): boolean => {
    if (!only.length) return true;
    const top = getNode(compiled, node.topFrameId);
    const names = [top?.id, top?.sourceId, typeof top?.props.name === "string" ? top.props.name : undefined];
    return names.some((n) => n !== undefined && only.some((re) => re.test(n)));
  };
  const ignored = (slot: Slot): boolean => {
    const list = Array.isArray(cfg.ignoreValues) ? cfg.ignoreValues : (cfg.ignoreValues[slot.controlled] ?? []);
    return isIgnored(slot.value, list);
  };

  const all = compiled.nodes.flatMap((node) => literalSlots(node, enabled).map((slot) => ({ node, slot })));
  const affected = affectedInstances(compiled, all);
  const indexes = new Map<string, Map<string, string[]>>();
  const out: Violation[] = [];
  for (const { node, slot } of all) {
    if (!inScope(node) || isInherited(node, slot) || ignored(slot)) continue;
    let index = indexes.get(node.themeKey);
    if (!index) indexes.set(node.themeKey, (index = variableIndex(compiled, node.theme)));
    const key = valueKey(slot);
    const fix = fixFor(slot, key === undefined ? undefined : index.get(key));
    const instances = affected.get(affectedKey(node, slot));
    out.push({
      rule: "TOK-001",
      severity: BLOCKING.has(slot.controlled) ? "block" : "warn",
      file: compiled.file,
      nodeId: node.id,
      path: node.path,
      prop: slot.prop,
      message: `Hard-coded ${slot.controlled} value ${String(slot.value)}; use a variable`,
      ...(fix ? { fix } : {}),
      ...(instances?.length ? { affectedInstances: instances } : {}),
    });
  }
  return out.sort((a, b) => cmp(a.nodeId, b.nodeId) || cmp(a.prop ?? "", b.prop ?? ""));
}
