import type { PenNode } from "../pen/types.js";

/** Own props left out of a component-mode hash: identity, placement and copy. */
const EXCLUDED = new Set(["id", "name", "x", "y", "content", "metadata", "reusable", "children"]);
/** Deeper subtrees (or values) are hashed as a marker, so hostile documents cannot overflow the stack. */
const MAX_DEPTH = 128;

function canonical(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return "…";
  if (Array.isArray(value)) return value.map((v) => canonical(v, depth + 1));
  if (typeof value !== "object" || value === null) return value ?? null;
  return Object.keys(value).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k], depth + 1)]);
}

function componentShape(node: PenNode, depth: number): unknown {
  if (depth > MAX_DEPTH) return "…";
  const props = Object.keys(node).filter((k) => !EXCLUDED.has(k)).sort().map((k) => [k, canonical(node[k], depth + 1)]);
  return [props, (node.children ?? []).map((c) => componentShape(c, depth + 1))];
}

/**
 * Hash for finding duplicated components: node type and every own prop except id, name, x, y,
 * content, metadata and reusable, plus children recursively; object keys are sorted so key order is
 * irrelevant.
 */
export function componentHash(node: PenNode): string {
  return JSON.stringify(componentShape(node, 0));
}
