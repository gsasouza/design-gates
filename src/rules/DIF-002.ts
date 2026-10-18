import { ruleChanges } from "../diff/rule-changes.js";
import type { Rule, Violation } from "../gates/types.js";
import { matchesScope } from "./scope.js";

const MAX_LISTED = 10;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const dif002: Rule = (compiled, config, diff) => {
  const base = diff?.base;
  const scope = config.rules["DIF-002"].scope;
  if (!diff || !base || scope.length === 0) return [];
  const out: Violation[] = [];
  for (const frame of ruleChanges(base, diff.head)) {
    const frameNames = [frame.baseId, frame.baseName, frame.headId, frame.headName];
    if (matchesScope(scope, ...frameNames)) continue;
    const outside = [...new Set(frame.changes.filter((c) => !matchesScope(scope, c.id)).map((c) => c.id))].sort(cmp);
    if (outside.length === 0) continue;
    const nodeId = frame.headNodeId ?? frame.baseNodeId;
    if (nodeId === undefined) continue;
    const listed = outside.slice(0, MAX_LISTED).join(", ") + (outside.length > MAX_LISTED ? ` (+${outside.length - MAX_LISTED} more)` : "");
    out.push({
      rule: "DIF-002",
      severity: config.strict ? "block" : "warn",
      file: compiled.file,
      nodeId,
      path: nodeId,
      message: `Frame "${frame.headName ?? frame.baseName ?? frame.headId ?? frame.baseId}" changed outside the declared scope: ${listed}`,
    });
  }
  return out.sort((a, b) => cmp(a.nodeId, b.nodeId));
};
