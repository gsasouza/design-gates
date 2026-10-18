import { getNode } from "../compile/query.js";
import type { CompiledDocument, CompiledNode } from "../compile/types.js";
import type { PenNode } from "../pen/types.js";

const MAX_DEPTH = 128;

/** Source-level view of a compiled subtree; nodes copied from a component below an instance are left out. */
export function toPen(compiled: CompiledDocument, node: CompiledNode, depth = 0): PenNode {
  const children = depth >= MAX_DEPTH ? [] : node.children.map((id) => getNode(compiled, id)).filter((c): c is CompiledNode => c !== undefined && !c.expanded);
  // An instance keeps only what it sets itself, not the props copied from its component.
  const isInstance = node.instanceOf !== undefined;
  const props = isInstance ? Object.fromEntries(Object.entries(node.props).filter(([k]) => node.provenance[k]?.origin === "instance")) : node.props;
  return { id: node.sourceId, type: isInstance ? "ref" : node.type, ...(isInstance ? { ref: node.instanceOf } : {}), ...props, ...(children.length ? { children: children.map((c) => toPen(compiled, c, depth + 1)) } : {}) } as PenNode;
}
