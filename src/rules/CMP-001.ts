import { getNode, listComponents } from "../compile/query.js";
import type { CompiledDocument, CompiledNode } from "../compile/types.js";
import { toPen } from "../diff/source-pen.js";
import { structureHash } from "../diff/match.js";
import { baxterSimilarity, similarityUpperBound } from "../diff/similarity.js";
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
  const { minNodes, similarity } = config.rules["CMP-001"];
  const components = listComponents(compiled).map((c) => ({ node: c, pen: toPen(compiled, c) }));
  const byId = (a: { node: { id: string } }, b: { node: { id: string } }): number => (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0);
  const sortedComponents = components.map((c) => ({ ...c, size: countNodes(c.pen) })).sort(byId);
  const byHash = new Map<string, typeof components>();
  for (const c of components) {
    const h = structureHash(c.pen, { mode: "component" });
    byHash.set(h, [...(byHash.get(h) ?? []), c]);
  }
  const out: Violation[] = [];
  const eligible = (node: CompiledNode): boolean => !(node.expanded || node.type === "ref" || node.instanceOf !== undefined || node.props.reusable === true);
  const exactBelow = new Map<string, boolean>();
  /** Whether the visit below would report an exact match at this node or any descendant. */
  const hasExact = (node: CompiledNode, depth: number): boolean => {
    const known = exactBelow.get(node.id);
    if (known !== undefined) return known;
    let found = false;
    if (eligible(node)) {
      const pen = toPen(compiled, node);
      found = countNodes(pen) >= minNodes && byHash.has(structureHash(pen, { mode: "component" }));
      if (!found && depth < MAX_DEPTH) {
        found = node.children.some((id) => {
          const child = getNode(compiled, id);
          return child !== undefined && hasExact(child, depth + 1);
        });
      }
    }
    exactBelow.set(node.id, found);
    return found;
  };
  const nearMiss = (node: CompiledNode, pen: PenNode, depth: number): Violation | undefined => {
    if (similarity === undefined) return undefined;
    const nodes = countNodes(pen);
    if (nodes < minNodes || hasExact(node, depth)) return undefined;
    let best: { id: string; s: number } | undefined;
    for (const c of sortedComponents) {
      if (similarityUpperBound(nodes, c.size) < similarity) continue;
      const s = baxterSimilarity(pen, c.pen);
      if (s >= similarity && s < 1 && (best === undefined || s > best.s)) best = { id: c.node.id, s };
    }
    if (!best) return undefined;
    return {
      rule: "CMP-001",
      severity: "warn",
      file: compiled.file,
      nodeId: node.id,
      path: node.path,
      message: `Subtree is ${Math.round(best.s * 100)}% similar to component "${best.id}"; use an instance instead`,
    };
  };
  const visit = (node: CompiledNode, depth: number): void => {
    if (node.expanded || node.type === "ref" || node.instanceOf !== undefined || node.props.reusable === true) return;
    const pen = toPen(compiled, node);
    const matches = countNodes(pen) >= minNodes ? byHash.get(structureHash(pen, { mode: "component" })) : undefined;
    if (matches) {
      const [first, ...others] = [...matches].sort(byId);
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
    const near = nearMiss(node, pen, depth);
    if (near) {
      out.push(near);
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
