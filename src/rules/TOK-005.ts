import type { CompiledDocument, CompiledNode } from "../compile/types.js";
import type { GatesConfig } from "../gates/config.js";
import { isControlledProp } from "../gates/tok.js";
import type { Fix, Violation } from "../gates/types.js";
import { affectedInstances, isInherited, literalSlots, tok001Filter, TOK_BLOCKING, variableIndex, valueKey, type Slot } from "./tok-slots.js";

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A literal slot whose value equals the value of one or more variables in the node's theme. */
export interface RawTokenMatch {
  node: CompiledNode;
  slot: Slot;
  /** Matching variables as `$name`, sorted. */
  names: string[];
}

/** True when `rules.TOK-005` is configured and not switched off. */
export const tok005Enabled = (config: GatesConfig): boolean => config.rules["TOK-005"].enabled === true && config.rules["TOK-005"].severity !== "off";

/**
 * Literals that equal an existing token. Honours TOK-001's `onlyIn` and `ignoreValues`, so a slot
 * TOK-001 skips is never reported here; inherited literals are left to the component's own node.
 */
export function rawTokenMatches(compiled: CompiledDocument, config: GatesConfig): RawTokenMatch[] {
  const enabled = new Set(config.rules["TOK-005"].properties.filter(isControlledProp));
  const reported = tok001Filter(compiled, config.rules["TOK-001"]);
  const indexes = new Map<string, Map<string, string[]>>();
  const out: RawTokenMatch[] = [];
  for (const node of compiled.nodes) {
    for (const slot of literalSlots(node, enabled)) {
      if (!reported(node, slot) || isInherited(node, slot)) continue;
      let index = indexes.get(node.themeKey);
      if (!index) indexes.set(node.themeKey, (index = variableIndex(compiled, node.theme)));
      const key = valueKey(slot);
      const names = key === undefined ? undefined : index.get(key);
      if (names?.length) out.push({ node, slot, names });
    }
  }
  return out;
}

/** TOK-005: a literal equal to a token's value, written raw instead of bound to the variable (opt-in). */
export function run(compiled: CompiledDocument, config: GatesConfig): Violation[] {
  const out: Violation[] = rawTokenMatches(compiled, config).map(({ node, slot, names }) => {
    const fix: Fix = names.length === 1 ? { type: "replace", prop: slot.prop, value: names[0]! } : { type: "candidates", prop: slot.prop, candidates: [...names] };
    const instances = affectedInstances(compiled, node);
    return {
      rule: "TOK-005",
      severity: TOK_BLOCKING.has(slot.controlled) ? "block" : "warn",
      file: compiled.file,
      nodeId: node.id,
      path: node.path,
      prop: slot.prop,
      message: `${slot.controlled} ${String(slot.value)} equals token ${names.join(", ")}; bind the variable so token changes propagate`,
      fix,
      ...(instances ? { affectedInstances: instances } : {}),
    };
  });
  return out.sort((a, b) => cmp(a.nodeId, b.nodeId) || cmp(a.prop ?? "", b.prop ?? ""));
}
