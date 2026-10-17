import type { CompiledDocument } from "../compile/types.js";
import type { Violation } from "../gates/types.js";
import { RULE_ALIASES } from "./baseline.js";

export const SUPPRESSION_NO_REASON = "design-gates suppression without reason";

export interface Suppressions {
  /** Rule ids suppressed per compiled node id, for the node and its subtree. */
  byNode: Map<string, Set<string>>;
  /** One block violation per suppression marker without a usable reason. */
  invalid: Violation[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads `metadata: { type: 'design-gates', ignore, reason }` markers; a marker with an `ignore` list but no non-empty reason suppresses nothing. */
export function collectSuppressions(compiled: CompiledDocument, file: string): Suppressions {
  const byNode = new Map<string, Set<string>>();
  const invalid: Violation[] = [];
  for (const node of compiled.nodes) {
    const meta = node.props.metadata;
    if (!isObject(meta) || meta.type !== "design-gates") continue;
    const reason = typeof meta.reason === "string" ? meta.reason.trim() : "";
    const ignore = Array.isArray(meta.ignore) ? meta.ignore.filter((r): r is string => typeof r === "string") : [];
    // A marker that only carries states / variant keys suppresses nothing and needs no reason.
    // A non-array `ignore` still counts as an ignore attempt and needs a reason; only an absent or empty list is silent.
    if (meta.ignore === undefined || (Array.isArray(meta.ignore) && meta.ignore.length === 0)) continue;
    if (reason === "") {
      // Nodes expanded from a component repeat the component's marker; report it once, on the source.
      if (!node.expanded) invalid.push({ rule: "SCH-001", severity: "block", file, nodeId: node.id, path: node.path, message: SUPPRESSION_NO_REASON });
      continue;
    }
    byNode.set(node.id, new Set(ignore));
  }
  return { byNode, invalid };
}

/** Drops the violations covered by a suppression on their node or an ancestor. */
export function applySuppressions(violations: Violation[], compiled: CompiledDocument, byNode: Map<string, Set<string>>): Violation[] {
  if (byNode.size === 0) return violations;
  const parents = new Map(compiled.nodes.map((n) => [n.id, n.parents]));
  return violations.filter((v) => {
    if (v.nodeId === "") return true;
    const rules = [v.rule, ...(RULE_ALIASES[v.rule] ?? [])];
    return ![v.nodeId, ...(parents.get(v.nodeId) ?? [])].some((id) => rules.some((r) => byNode.get(id)?.has(r)));
  });
}
