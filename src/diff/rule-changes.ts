import { getNode } from "../compile/query.js";
import type { CompiledDocument } from "../compile/types.js";
import type { PenNode } from "../pen/types.js";
import { matchFrames } from "./match.js";
import type { NodeChangeKind } from "./model.js";
import { toPen } from "./source-pen.js";
import { diffFrame } from "./semantic.js";

export interface RuleNodeChange {
  /** Source id of the node. */
  id: string;
  change: NodeChangeKind;
}

/** What changed in one top-level frame between base and head; a side is absent for an added or removed frame. */
export interface RuleFrameChanges {
  baseId?: string;
  baseName?: string;
  /** Compiled id of the base frame. */
  baseNodeId?: string;
  headId?: string;
  headName?: string;
  /** Compiled id of the head frame. */
  headNodeId?: string;
  /** Sorted by id, then change kind. */
  changes: RuleNodeChange[];
  basePen?: PenNode;
  headPen?: PenNode;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const KIND_ORDER: NodeChangeKind[] = ["added", "removed", "modified", "moved", "reordered"];

interface Side {
  pens: PenNode[];
  compiledId: Map<PenNode, string>;
}

function sideOf(compiled: CompiledDocument): Side {
  const pens: PenNode[] = [];
  const compiledId = new Map<PenNode, string>();
  for (const id of compiled.topLevel) {
    const node = getNode(compiled, id);
    if (!node) continue;
    const pen = toPen(compiled, node);
    pens.push(pen);
    compiledId.set(pen, node.id);
  }
  return { pens, compiledId };
}

function everyNode(root: PenNode, change: NodeChangeKind, depth = 0): RuleNodeChange[] {
  const own: RuleNodeChange[] = [{ id: root.id, change }];
  return depth >= 128 ? own : own.concat(...(root.children ?? []).map((c) => everyNode(c, change, depth + 1)));
}

/**
 * Per top-level frame, the node changes between base and head as the rules see them: source-level
 * trees (component copies skipped), frames paired by `matchFrames`, every pair diffed in id mode so a
 * node recreated with a new id is removed + added. Where a pair was matched by structure or name and
 * the roots' ids differ, the root is `modified` on the head id. Added and removed frames contribute
 * every node. Ordered by head frame id (base id when removed).
 */
export function ruleChanges(base: CompiledDocument, head: CompiledDocument): RuleFrameChanges[] {
  const b = sideOf(base);
  const h = sideOf(head);
  const matches = matchFrames(b.pens, h.pens);
  const info = (pen: PenNode | undefined, side: Side, prefix: "base" | "head"): Partial<RuleFrameChanges> =>
    pen ? { [`${prefix}Id`]: pen.id, ...(pen.name !== undefined && { [`${prefix}Name`]: pen.name }), [`${prefix}NodeId`]: side.compiledId.get(pen), [`${prefix}Pen`]: pen } : {};
  const sortChanges = (list: RuleNodeChange[]): RuleNodeChange[] => list.sort((x, y) => cmp(x.id, y.id) || KIND_ORDER.indexOf(x.change) - KIND_ORDER.indexOf(y.change));
  const out: RuleFrameChanges[] = [
    ...matches.pairs.map((p) => ({ ...info(p.base, b, "base"), ...info(p.head, h, "head"), changes: sortChanges(diffFrame(p.base, p.head, "id").nodes.map((n) => ({ id: n.id, change: n.change }))) })),
    ...matches.added.map((p) => ({ ...info(p, h, "head"), changes: sortChanges(everyNode(p, "added")) })),
    ...matches.removed.map((p) => ({ ...info(p, b, "base"), changes: sortChanges(everyNode(p, "removed")) })),
  ];
  return out.sort((x, y) => cmp(x.headNodeId ?? x.baseNodeId ?? "", y.headNodeId ?? y.baseNodeId ?? ""));
}
