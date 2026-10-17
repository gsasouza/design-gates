import type { CompiledDocument } from "../compile/types.js";
import type { GatesConfig } from "../gates/config.js";
import { isControlledProp } from "../gates/tok.js";
import type { Fix, Violation } from "../gates/types.js";
import { rawTokenMatches, tok005Enabled } from "./TOK-005.js";
import { affectedInstances, isInherited, literalSlots, tok001Filter, TOK_BLOCKING, variableIndex, valueKey, type Slot } from "./tok-slots.js";

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function fixFor(slot: Slot, names: string[] | undefined): Fix | undefined {
  if (!names?.length) return undefined;
  return names.length === 1 ? { type: "replace", prop: slot.prop, value: names[0] } : { type: "candidates", prop: slot.prop, candidates: [...names] };
}

/** TOK-001: hard-coded values in properties that should use design tokens. */
export function run(compiled: CompiledDocument, config: GatesConfig): Violation[] {
  const cfg = config.rules["TOK-001"];
  const enabled = new Set(cfg.properties.filter(isControlledProp));
  const reported = tok001Filter(compiled, cfg);
  const taken = tok005Enabled(config) ? new Set(rawTokenMatches(compiled, config).map((m) => `${m.node.id}\0${m.slot.prop}`)) : undefined;

  const indexes = new Map<string, Map<string, string[]>>();
  const out: Violation[] = [];
  for (const node of compiled.nodes) {
    for (const slot of literalSlots(node, enabled)) {
      if (!reported(node, slot) || isInherited(node, slot)) continue;
      if (taken?.has(`${node.id}\0${slot.prop}`)) continue;
      let index = indexes.get(node.themeKey);
      if (!index) indexes.set(node.themeKey, (index = variableIndex(compiled, node.theme)));
      const key = valueKey(slot);
      const fix = fixFor(slot, key === undefined ? undefined : index.get(key));
      const instances = affectedInstances(compiled, node);
      out.push({
        rule: "TOK-001",
        severity: TOK_BLOCKING.has(slot.controlled) ? "block" : "warn",
        file: compiled.file,
        nodeId: node.id,
        path: node.path,
        prop: slot.prop,
        message: `Hard-coded ${slot.controlled} value ${String(slot.value)}; use a variable`,
        ...(fix ? { fix } : {}),
        ...(instances ? { affectedInstances: instances } : {}),
      });
    }
  }
  return out.sort((a, b) => cmp(a.nodeId, b.nodeId) || cmp(a.prop ?? "", b.prop ?? ""));
}
