import type { SceneNode } from "@open-pencil/core";
import { figNodeId } from "../fig/props.js";
import type { PenDocument, PenNode } from "../pen/types.js";

/**
 * Graph id by document id for the nodes the normalized `doc` emits. Only emitted ids must be unique;
 * nodes the normalizer never emits (instance-subtree clones) may share a fallback id with one, and a
 * node whose id is a real GUID wins such a clash. Throws on two emitted nodes with the same id.
 */
export function emittedIdMap(doc: PenDocument, nodes: readonly SceneNode[], guids: ReadonlyMap<string, string>): Map<string, string> {
  const emitted = new Set<string>();
  const visit = (list: readonly PenNode[]): void => {
    for (const node of list) {
      if (emitted.has(node.id)) throw new Error(`two nodes with the id ${node.id}`);
      emitted.add(node.id);
      visit(node.children ?? []);
    }
  };
  visit(doc.children);

  const ids = new Map<string, string>();
  for (const node of nodes) {
    const id = figNodeId(node, guids);
    if (!emitted.has(id)) continue;
    if (!ids.has(id) || node.source.id || guids.has(node.id)) ids.set(id, node.id);
  }
  return ids;
}
