import type { PenNode } from "../pen/types.js";
import type { FrameCounts, MatchedBy, NodeChange, NodeChangeKind, PropChange } from "./model.js";

export interface FrameDiffResult {
  nodes: NodeChange[];
  counts: FrameCounts;
}

const KIND_ORDER: NodeChangeKind[] = ["added", "removed", "modified", "moved", "reordered"];

interface Entry {
  node: PenNode;
  parent: PenNode | null;
  index: number;
  key: string;
}

/** Flatten a subtree; `key` is the path of type+name+index among same type+name siblings. */
function collect(root: PenNode): Entry[] {
  const out: Entry[] = [];
  const walk = (node: PenNode, parent: PenNode | null, index: number, key: string): void => {
    out.push({ node, parent, index, key });
    const seen = new Map<string, number>();
    (node.children ?? []).forEach((child, i) => {
      const label = `${child.type}:${child.name ?? ""}`;
      const n = seen.get(label) ?? 0;
      seen.set(label, n + 1);
      walk(child, node, i, `${key}/${label}[${n}]`);
    });
  };
  walk(root, null, 0, "");
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepDiff(a: unknown, b: unknown, path: string, out: PropChange[]): void {
  if (isObject(a) && isObject(b)) {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      deepDiff(a[k], b[k], path ? `${path}.${k}` : k, out);
    }
  } else if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    a.forEach((v, i) => deepDiff(v, b[i], `${path}.${i}`, out));
  } else if (JSON.stringify(a) !== JSON.stringify(b)) {
    out.push({ path, old: a, new: b });
  }
}

/** Indices (into `seq`) of one longest strictly increasing subsequence. */
function lisIndices(seq: number[]): Set<number> {
  const tails: number[] = [];
  const prev: number[] = [];
  seq.forEach((v, i) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]!]! < v) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo > 0 ? tails[lo - 1]! : -1;
    tails[lo] = i;
  });
  const keep = new Set<number>();
  for (let i = tails.length ? tails[tails.length - 1]! : -1; i >= 0; i = prev[i]!) keep.add(i);
  return keep;
}

/** Semantic diff of one matched frame pair. */
export function diffFrame(baseFrame: PenNode, headFrame: PenNode, matchedBy: MatchedBy): FrameDiffResult {
  const byId = matchedBy === "id";
  const baseEntries = collect(baseFrame);
  const headEntries = collect(headFrame);
  const idOf = (e: Entry): string => (byId ? e.node.id : e.key);

  const headLookup = new Map<string, Entry>();
  for (const e of headEntries) if (!headLookup.has(idOf(e))) headLookup.set(idOf(e), e);
  // The frame roots are always the same frame, whatever their ids.
  const pair = new Map<PenNode, Entry>();
  const pairedHead = new Set<PenNode>();
  const pairUp = (b: Entry, h: Entry): void => {
    pair.set(b.node, h);
    pairedHead.add(h.node);
  };
  pairUp(baseEntries[0]!, headEntries[0]!);
  for (const b of baseEntries.slice(1)) {
    const h = headLookup.get(idOf(b));
    if (h && !pairedHead.has(h.node) && h !== headEntries[0]) pairUp(b, h);
  }

  const headIdOf = new Map<string, string>();
  for (const [b, h] of pair) headIdOf.set(b.id, h.node.id);

  const changes: NodeChange[] = [];
  const push = (node: PenNode, change: NodeChangeKind, extra: Partial<NodeChange> = {}): void => {
    changes.push({ id: node.id, name: node.name ?? "", type: node.type, change, ...extra });
  };
  const baseEntryOf = new Map(baseEntries.map((e) => [e.node, e]));

  for (const e of baseEntries) if (!pair.has(e.node)) push(e.node, "removed");
  for (const e of headEntries) if (!pairedHead.has(e.node)) push(e.node, "added");

  for (const [bNode, h] of pair) {
    const hNode = h.node;
    const b = baseEntryOf.get(bNode)!;
    const props: PropChange[] = [];
    const strip = (n: PenNode): Record<string, unknown> => {
      const { children: _children, ...rest } = n as Record<string, unknown>;
      if (!byId) delete rest.id;
      return rest;
    };
    const a = strip(bNode);
    const c = strip(hNode);
    if (!byId && typeof a.ref === "string" && headIdOf.get(a.ref) === c.ref) {
      delete a.ref;
      delete c.ref;
    }
    deepDiff(a, c, "", props);
    if (props.length) push(hNode, "modified", { props });

    const baseParent = b.parent;
    const headParent = h.parent;
    if (baseParent && headParent && pair.get(baseParent)?.node !== headParent) {
      push(hNode, "moved", { from: baseParent.id, to: headParent.id });
    }
  }

  // Reordered: among siblings that kept their parent, those outside the LIS of base indices.
  const baseOf = new Map<PenNode, Entry>();
  for (const [bNode, h] of pair) baseOf.set(h.node, baseEntryOf.get(bNode)!);
  for (const parent of headEntries.map((e) => e.node)) {
    const kept = (parent.children ?? []).flatMap((child) => {
      const b = baseOf.get(child);
      const same = b?.parent && pair.get(b.parent)?.node === parent;
      return b && same ? [{ child, baseIndex: b.index }] : [];
    });
    const keep = lisIndices(kept.map((k) => k.baseIndex));
    kept.forEach((k, i) => {
      if (!keep.has(i)) push(k.child, "reordered");
    });
  }

  changes.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : KIND_ORDER.indexOf(x.change) - KIND_ORDER.indexOf(y.change)));
  const counts: FrameCounts = { added: 0, removed: 0, modified: 0, moved: 0, reordered: 0 };
  for (const c of changes) counts[c.change]++;
  return { nodes: changes, counts };
}
