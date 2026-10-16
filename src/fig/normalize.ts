import type { SceneGraph, SceneNode } from "@open-pencil/core";
import type { PenDocument, PenNode } from "../pen/types.js";

/** Stable id of a scene node: its Figma GUID, which survives sibling reordering (graph ids are assigned by file order). */
export function figNodeId(node: SceneNode): string {
  return node.source.id ?? node.id;
}

function toPenNode(graph: SceneGraph, node: SceneNode): PenNode {
  const children = node.childIds.flatMap((id) => {
    const child = graph.getNode(id);
    return child ? [toPenNode(graph, child)] : [];
  });
  return {
    id: figNodeId(node),
    type: node.type.toLowerCase(),
    name: node.name,
    ...(children.length > 0 && { children }),
  };
}

/**
 * Normalizes a parsed `.fig` scene into a PenDocument: pages as top-level children, node ids being
 * the Figma GUIDs.
 * TODO(follow-up card): map geometry, fills, text, auto layout, components and variables so the diff and rules see real properties.
 */
export function figSceneToPen(graph: SceneGraph): PenDocument {
  return {
    version: "2.6",
    children: graph.getPages(true).map((page) => toPenNode(graph, page)),
  };
}
