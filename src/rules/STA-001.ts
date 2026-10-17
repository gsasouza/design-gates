import type { Rule, Violation } from "../gates/types.js";
import { breakpointNaming } from "./RSP-001.js";
import { isVariant, listCandidates, markerOf, variantsOf, type VariantNaming } from "./variants.js";

const globToRegExp = (glob: string): RegExp => new RegExp(`^${glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const sta001: Rule = (compiled, config) => {
  const { states, screens, pattern } = config.rules["STA-001"];
  const globs = screens.map(globToRegExp);
  // Breakpoint variants (by RSP-001's configured naming, or metadata) never declare data.
  const naming: VariantNaming = { statePattern: pattern, states, ...breakpointNaming(config) };
  const out: Violation[] = [];
  for (const candidate of listCandidates(compiled)) {
    const { node, name } = candidate;
    const declares = markerOf(node)?.states === true || globs.some((g) => [name, node.sourceId, node.id].some((s) => g.test(s)));
    if (!declares || isVariant(compiled, candidate, naming)) continue;
    for (const state of states) {
      if (variantsOf(compiled, candidate, "state", state, naming).length > 0) continue;
      out.push({
        rule: "STA-001",
        severity: "warn",
        file: compiled.file,
        nodeId: node.id,
        path: node.path,
        prop: `states.${state}`,
        message: `${candidate.kind === "screen" ? "Screen" : "Component"} "${name}" has no "${state}" state variant`,
      });
    }
  }
  return out.sort((a, b) => cmp(a.nodeId, b.nodeId) || cmp(a.prop ?? "", b.prop ?? ""));
};
