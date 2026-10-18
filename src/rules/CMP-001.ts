import { getNode, listComponents } from "../compile/query.js";
import type { CompiledDocument, CompiledNode } from "../compile/types.js";
import { toPen } from "../diff/source-pen.js";
import { structureHash } from "../diff/match.js";
import type { Rule, Violation } from "../gates/types.js";
import type { PenNode } from "../pen/types.js";

const MAX_DEPTH = 128;

const countNodes = (n: PenNode, depth = 0): number => 1 + (depth >= MAX_DEPTH ? 0 : (n.children ?? []).reduce((sum, c) => sum + countNodes(c, depth + 1), 0));

/** Text `content` differences between two same-shaped trees, keyed by the slash-separated source id path below the root. */
function contentOverrides(component: PenNode, copy: PenNode, path: string[], out: Record<string, Partial<PenNode>>, depth = 0): void {
  if (path.length > 0 && component.type === "text" && component.content !== copy.content && copy.content !== undefined) {
    out[path.join("/")] = { content: copy.content };
  }
  if (depth >= MAX_DEPTH) return;
  (component.children ?? []).forEach((c, i) => {
    const other = copy.children?.[i];
    if (other) contentOverrides(c, other, [...path, c.id], out, depth + 1);
  });
}

export const cmp001: Rule = (compiled, config) => {
  const minNodes = config.rules["CMP-001"].minNodes;
  const components = listComponents(compiled).map((c) => ({ node: c, pen: toPen(compiled, c) }));
  const byHash = new Map<string, typeof components>();
  for (const c of components) {
    const h = structureHash(c.pen, { mode: "component" });
    byHash.set(h, [...(byHash.get(h) ?? []), c]);
  }
  const out: Violation[] = [];
  const visit = (node: CompiledNode, depth: number): void => {
    if (node.expanded || node.type === "ref" || node.instanceOf !== undefined || node.props.reusable === true) return;
    const pen = toPen(compiled, node);
    const matches = countNodes(pen) >= minNodes ? byHash.get(structureHash(pen, { mode: "component" })) : undefined;
    if (matches) {
      const [first, ...others] = [...matches].sort((a, b) => (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0));
      const descendants: Record<string, Partial<PenNode>> = {};
      contentOverrides(first!.pen, pen, [], descendants);
      const sorted = Object.fromEntries(Object.entries(descendants).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
      out.push({
        rule: "CMP-001",
        severity: "warn",
        file: compiled.file,
        nodeId: node.id,
        path: node.path,
        message: `Subtree duplicates component "${first!.node.id}"${others.length ? ` (also matches ${others.map((o) => `"${o.node.id}"`).join(", ")})` : ""}; use an instance instead`,
        fix: { type: "ref", ref: first!.node.id, descendants: sorted },
      });
      return;
    }
    if (depth >= MAX_DEPTH) return;
    for (const id of node.children) {
      const child = getNode(compiled, id);
      if (child) visit(child, depth + 1);
    }
  };
  for (const id of compiled.topLevel) {
    const top = getNode(compiled, id);
    if (top) visit(top, 0);
  }
  return out;
};
