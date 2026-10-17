import type { SceneGraph, SceneNode } from "@open-pencil/core";

/** The part of a decoded kiwi node change that pairs it with a graph node. */
export interface NodeChange {
  guid?: { sessionID: number; localID: number };
  parentIndex?: { guid?: { sessionID: number; localID: number }; position?: string };
}

const guidKey = (g: { sessionID: number; localID: number }): string => `${g.sessionID}:${g.localID}`;

/**
 * Figma GUIDs for the nodes the reader gives no `source.id` (components, instances and what sits
 * under them), found by pairing the graph's tree with the file's node changes in sibling order.
 * Keyed by graph node id; a subtree whose shape does not pair up is left out (the caller falls back).
 */
export function figGuids(graph: SceneGraph, changes: readonly NodeChange[]): Map<string, string> {
  const out = new Map<string, string>();

  const byParent = new Map<string, NodeChange[]>();
  for (const change of changes) {
    const parent = change.parentIndex?.guid;
    if (!parent || !change.guid) continue;
    byParent.set(guidKey(parent), [...(byParent.get(guidKey(parent)) ?? []), change]);
  }
  for (const list of byParent.values()) list.sort((a, b) => ((a.parentIndex?.position ?? "") < (b.parentIndex?.position ?? "") ? -1 : 1));

  const walk = (node: SceneNode, guid: string): void => {
    out.set(node.id, guid);
    if (node.type === "INSTANCE") return;
    const kids = graph.getChildren(node.id).filter((c) => !c.internalOnly);
    const pairs = byParent.get(guid) ?? [];
    if (kids.length !== pairs.length) return;
    // A reader-given id that disagrees with the paired change means the shapes do not pair: skip the subtree.
    if (kids.some((kid, i) => kid.source.id && kid.source.id !== guidKey(pairs[i]!.guid!))) return;
    kids.forEach((kid, i) => walk(kid, kid.source.id ?? guidKey(pairs[i]!.guid!)));
  };
  for (const page of graph.getPages()) if (page.source.id) walk(page, page.source.id);
  return out;
}
