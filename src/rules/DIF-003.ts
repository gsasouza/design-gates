import { ruleChanges } from "../diff/rule-changes.js";
import type { Rule, Violation } from "../gates/types.js";

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** DIF-003: a node removed since the base that the pen map or a code marker still references (opt-in, only with --base). */
export const dif003: Rule = (compiled, _config, diff, contract) => {
  const base = diff?.base;
  if (!diff || !base || !contract || (!contract.map && !contract.markers)) return [];
  const removed = new Set<string>();
  const added = new Set<string>();
  for (const frame of ruleChanges(base, diff.head)) {
    for (const c of frame.changes) {
      if (c.change === "removed") removed.add(c.id);
      else if (c.change === "added") added.add(c.id);
    }
  }
  const out: Violation[] = [];
  for (const id of [...removed].sort(cmp)) {
    // an id on both sides is a move between frames, not a removal
    if (added.has(id)) continue;
    const node = base.nodes.find((n) => n.sourceId === id && !n.expanded);
    if (!node) continue;
    const refs: string[] = [];
    if (contract.map?.entries.has(id)) refs.push(contract.mapFile);
    const marks = (contract.markers?.get(id) ?? []).map((m) => `${m.file}:${m.line}`).sort(cmp);
    refs.push(...marks);
    if (refs.length === 0) continue;
    out.push({
      rule: "DIF-003",
      severity: "block",
      file: compiled.file,
      nodeId: id,
      path: node.path,
      message: `Node "${id}" was removed but is still referenced by ${refs.join(", ")}`,
    });
  }
  return out;
};
