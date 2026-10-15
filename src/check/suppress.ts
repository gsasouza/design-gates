import type { CompiledDocument } from "../compile/types.js";
import type { Violation } from "../gates/types.js";

export const SUPPRESSION_NO_REASON = "design-gates suppression without reason";

export interface Suppressions {
  /** Rule ids suppressed per compiled node id, for the node and its subtree. */
  byNode: Map<string, Set<string>>;
  /** One block violation per suppression marker without a usable reason. */
  invalid: Violation[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads `metadata: { type: 'design-gates', ignore, reason }` markers; a marker without a non-empty reason suppresses nothing. */
export function collectSuppressions(compiled: CompiledDocument, file: string): Suppressions {
  const byNode = new Map<string, Set<string>>();
  const invalid: Violation[] = [];
  for (const node of compiled.nodes) {
    const meta = node.props.metadata;
    if (!isObject(meta) || meta.type !== "design-gates") continue;
    const reason = typeof meta.reason === "string" ? meta.reason.trim() : "";
    if (reason === "") {
      // Nodes expanded from a component repeat the component's marker; report it once, on the source.
      if (!node.expanded) invalid.push({ rule: "SCH-001", severity: "block", file, nodeId: node.id, path: node.path, message: SUPPRESSION_NO_REASON });
      continue;
    }
    const ignore = Array.isArray(meta.ignore) ? meta.ignore.filter((r): r is string => typeof r === "string") : [];
    if (ignore.length > 0) byNode.set(node.id, new Set(ignore));
  }
  return { byNode, invalid };
}

/** Drops the violations covered by a suppression on their node or an ancestor. */
export function applySuppressions(violations: Violation[], compiled: CompiledDocument, byNode: Map<string, Set<string>>): Violation[] {
  if (byNode.size === 0) return violations;
  const parents = new Map(compiled.nodes.map((n) => [n.id, n.parents]));
  return violations.filter((v) => {
    if (v.nodeId === "") return true;
    return ![v.nodeId, ...(parents.get(v.nodeId) ?? [])].some((id) => byNode.get(id)?.has(v.rule));
  });
}
