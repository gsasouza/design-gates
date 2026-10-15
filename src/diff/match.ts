import type { MatchedBy } from "./model.js";
import type { PenNode } from "../pen/types.js";

export interface FramePair {
  base: PenNode;
  head: PenNode;
  matchedBy: MatchedBy;
}

export interface FrameMatches {
  pairs: FramePair[];
  /** Head-only frames. */
  added: PenNode[];
  /** Base-only frames. */
  removed: PenNode[];
}

function shape(n: PenNode): unknown[] {
  const entry: unknown[] = [n.type, n.name ?? ""];
  if (n.type === "text") entry.push(typeof n.content === "string" ? n.content : "");
  entry.push((n.children ?? []).map(shape));
  return entry;
}

/** Hash of the subtree shape: node type + name (+ text content), ignoring ids, positions and styles. */
export function structureHash(frame: PenNode): string {
  return JSON.stringify(shape(frame));
}

function pairBy(
  base: PenNode[],
  head: PenNode[],
  key: (n: PenNode) => string,
  matchedBy: MatchedBy,
  unique: boolean,
): { pairs: FramePair[]; base: PenNode[]; head: PenNode[] } {
  const group = (nodes: PenNode[]): Map<string, PenNode[]> => {
    const m = new Map<string, PenNode[]>();
    for (const n of nodes) m.set(key(n), [...(m.get(key(n)) ?? []), n]);
    return m;
  };
  const headGroups = group(head);
  const baseGroups = group(base);
  const pairs: FramePair[] = [];
  const usedBase = new Set<PenNode>();
  const usedHead = new Set<PenNode>();
  for (const [k, bs] of baseGroups) {
    const hs = headGroups.get(k);
    if (!hs) continue;
    if (unique && (bs.length !== 1 || hs.length !== 1)) continue;
    for (let i = 0; i < Math.min(bs.length, hs.length); i++) {
      pairs.push({ base: bs[i]!, head: hs[i]!, matchedBy });
      usedBase.add(bs[i]!);
      usedHead.add(hs[i]!);
    }
  }
  return {
    pairs,
    base: base.filter((n) => !usedBase.has(n)),
    head: head.filter((n) => !usedHead.has(n)),
  };
}

/** Pair top-level frames by id, then by structure hash, then by unique name. */
export function matchFrames(baseFrames: PenNode[], headFrames: PenNode[]): FrameMatches {
  const headIds = new Set(headFrames.map((f) => f.id));
  const baseIds = new Set(baseFrames.map((f) => f.id));
  const byId: FramePair[] = [];
  for (const b of baseFrames) {
    const h = headFrames.find((f) => f.id === b.id);
    if (h) byId.push({ base: b, head: h, matchedBy: "id" });
  }
  let base = baseFrames.filter((f) => !headIds.has(f.id));
  let head = headFrames.filter((f) => !baseIds.has(f.id));

  const structural = pairBy(base, head, structureHash, "structure", false);
  base = structural.base;
  head = structural.head;
  const named = pairBy(base, head, (n) => n.name ?? "", "name", true);
  // Unnamed frames are never matched by name.
  const namedPairs = named.pairs.filter((p) => p.base.name);
  const unmatchedNamed = named.pairs.filter((p) => !p.base.name);
  return {
    pairs: [...byId, ...structural.pairs, ...namedPairs],
    removed: [...named.base, ...unmatchedNamed.map((p) => p.base)],
    added: [...named.head, ...unmatchedNamed.map((p) => p.head)],
  };
}
