import type { CompiledDocument } from "../compile/types.js";
import { getNode } from "../compile/query.js";
import { structureHash } from "../diff/match.js";
import { ruleChanges } from "../diff/rule-changes.js";
import { toPen } from "../diff/source-pen.js";
import type { PenNode } from "../pen/types.js";
import type { Rule, Violation } from "../gates/types.js";

const MAX_SAMPLES = 10;
const MAX_DEPTH = 128;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function indexNodes(root: PenNode | undefined, into: Map<string, PenNode>, depth = 0): void {
  if (!root || depth > MAX_DEPTH) return;
  if (!into.has(root.id)) into.set(root.id, root);
  for (const c of root.children ?? []) indexNodes(c, into, depth + 1);
}

/** Canonical form with `version`, ids, `ref` values and `descendants` keys ignored; object keys sorted. */
function canonical(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "…";
  if (Array.isArray(value)) return value.map((v) => canonical(v, depth + 1));
  if (typeof value !== "object" || value === null) return value ?? null;
  const obj = value as Record<string, unknown>;
  return Object.keys(obj)
    .filter((k) => k !== "id" && k !== "version")
    .sort()
    .map((k) => [k, k === "ref" ? null : k === "descendants" && typeof obj[k] === "object" && obj[k] !== null ? Object.values(obj[k] as object).map((v) => canonical(v, depth + 1)) : canonical(obj[k], depth + 1)]);
}

function sourceForm(doc: CompiledDocument): string {
  const trees = doc.topLevel.flatMap((id) => {
    const node = getNode(doc, id);
    return node ? [toPen(doc, node)] : [];
  });
  return JSON.stringify(canonical(trees));
}

export const dif004: Rule = (compiled, config, diff) => {
  const base = diff?.base;
  if (!diff || !base) return [];
  const frames = ruleChanges(base, diff.head);
  const baseNodes = new Map<string, PenNode>();
  const headNodes = new Map<string, PenNode>();
  const removed = new Set<string>();
  const added = new Set<string>();
  let changed = false;
  for (const f of frames) {
    indexNodes(f.basePen, baseNodes);
    indexNodes(f.headPen, headNodes);
    for (const c of f.changes) {
      changed = true;
      if (c.change === "removed") removed.add(c.id);
      else if (c.change === "added") added.add(c.id);
    }
  }
  // An id on both sides is a move or a kept id, not a recreation.
  const both = [...removed].filter((id) => added.has(id));
  for (const id of both) {
    removed.delete(id);
    added.delete(id);
  }
  const group = (ids: Set<string>, nodes: Map<string, PenNode>): Map<string, string[]> => {
    const m = new Map<string, string[]>();
    for (const id of [...ids].sort(cmp)) {
      const node = nodes.get(id);
      if (!node) continue;
      const h = structureHash(node, { mode: "component" });
      m.set(h, [...(m.get(h) ?? []), id]);
    }
    return m;
  };
  const removedBy = group(removed, baseNodes);
  const addedBy = group(added, headNodes);
  const pairs: string[] = [];
  for (const [h, olds] of removedBy) {
    const news = addedBy.get(h) ?? [];
    for (let i = 0; i < Math.min(olds.length, news.length); i++) pairs.push(`${olds[i]} -> ${news[i]}`);
  }
  pairs.sort(cmp);
  const versionOnly = base.version !== diff.head.version && changed && sourceForm(base) === sourceForm(diff.head);
  if (pairs.length < config.rules["DIF-004"].maxRecreated && !versionOnly) return [];
  const parts = [`${pairs.length} node${pairs.length === 1 ? "" : "s"} recreated with a new id`];
  if (versionOnly) parts.push(`version ${base.version} -> ${diff.head.version} with no semantic change`);
  if (pairs.length > 0) parts.push(`e.g. ${pairs.slice(0, MAX_SAMPLES).join(", ")}${pairs.length > MAX_SAMPLES ? ` (+${pairs.length - MAX_SAMPLES} more)` : ""}`);
  const v: Violation = { rule: "DIF-004", severity: "warn", file: compiled.file, nodeId: "#document", path: "#document", message: `Id churn: ${parts.join("; ")}` };
  return [v];
};
