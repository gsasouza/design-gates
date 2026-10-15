import type { PenDocument, PenNode } from "../pen/types.js";

function findNode(nodes: PenNode[], id: string): PenNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = node.children && findNode(node.children, id);
    if (found) return found;
  }
  return undefined;
}

/**
 * Deep copy of `doc` whose frame `frameId` pins `theme` (axis -> value); the subtree inherits it.
 * Axes already pinned on the frame are kept unless `theme` overrides them. The caller's document
 * is never mutated.
 */
export function withFrameTheme(doc: PenDocument, frameId: string, theme?: Record<string, string>): PenDocument {
  const copy = structuredClone(doc);
  if (!theme) return copy;
  const frame = findNode(copy.children, frameId);
  if (!frame) throw new Error(`Frame not found: ${frameId}`);
  frame.theme = { ...frame.theme, ...theme };
  return copy;
}
