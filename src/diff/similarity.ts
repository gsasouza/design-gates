import type { PenNode } from "../pen/types.js";
import { componentHash } from "./component-hash.js";

const MAX_DEPTH = 128;

interface Tally {
  shared: number;
  onlyA: number;
  onlyB: number;
}

const size = (n: PenNode, depth: number): number =>
  1 + (depth >= MAX_DEPTH ? 0 : (n.children ?? []).reduce((sum, c) => sum + size(c, depth + 1), 0));

/** Hash of the node's own type and component-mode props, without its children. */
const ownHash = (n: PenNode): string => componentHash({ ...n, children: undefined });

function align(a: PenNode, b: PenNode, depth: number, t: Tally): void {
  if (ownHash(a) === ownHash(b)) t.shared += 1;
  else {
    t.onlyA += 1;
    t.onlyB += 1;
  }
  if (depth >= MAX_DEPTH) return;
  const ac = a.children ?? [];
  const bc = b.children ?? [];
  for (let i = 0; i < Math.max(ac.length, bc.length); i++) {
    const x = ac[i];
    const y = bc[i];
    if (x && y) align(x, y, depth + 1, t);
    else if (x) t.onlyA += size(x, depth + 1);
    else if (y) t.onlyB += size(y, depth + 1);
  }
}

/** Largest similarity two trees of these node counts can have; lets callers skip hopeless pairs. */
export function similarityUpperBound(nodesA: number, nodesB: number): number {
  return (2 * Math.min(nodesA, nodesB)) / (nodesA + nodesB);
}

/**
 * Baxter similarity S = 2*shared / (2*shared + onlyInA + onlyInB). The trees are aligned top-down by
 * child index; an aligned pair is shared when type and own component-mode props are equal, otherwise
 * it counts once on each side and its children are still aligned. Unpaired children count with their
 * whole subtrees.
 */
export function baxterSimilarity(a: PenNode, b: PenNode): number {
  const t: Tally = { shared: 0, onlyA: 0, onlyB: 0 };
  align(a, b, 0, t);
  return (2 * t.shared) / (2 * t.shared + t.onlyA + t.onlyB);
}
