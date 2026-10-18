import { getNode, listInstances, resolveForTheme } from "../compile/query.js";
import type { CompiledDocument, CompiledNode } from "../compile/types.js";
import type { GatesConfig } from "../gates/config.js";
import type { Rule, Violation } from "../gates/types.js";

const ID = "A11Y-003";
const PROP = "fontSize";

interface Size {
  node: CompiledNode;
  value: number;
  variable?: string;
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The node's fontSize in its own effective theme; undefined when absent, unresolved or not a number. */
function sizeOf(compiled: CompiledDocument, node: CompiledNode): Size | undefined {
  const raw = node.props[PROP];
  if (typeof raw === "number") return Number.isFinite(raw) ? { node, value: raw } : undefined;
  if (typeof raw !== "string" || !raw.startsWith("$")) return undefined;
  const use = node.uses.find((u) => u.prop === PROP && u.status === "ok");
  const resolved = use ?? resolveForTheme(compiled, raw, node.theme);
  if (resolved.status !== "ok" || typeof resolved.value !== "number" || !Number.isFinite(resolved.value)) return undefined;
  return { node, value: resolved.value, variable: use ? `$${use.name}` : raw };
}

/** The component definition node a copy (an instance root or an expanded node) was copied from. */
function definitionOf(compiled: CompiledDocument, node: CompiledNode): CompiledNode | undefined {
  let cur = node.source === undefined ? undefined : getNode(compiled, node.source);
  for (let i = 0; i < 64 && cur?.expanded; i++) cur = cur.source === undefined ? undefined : getNode(compiled, cur.source);
  return cur && !cur.expanded ? cur : undefined;
}

const inherited = (n: CompiledNode): boolean => n.provenance[PROP]?.origin === "component";

/** The document-level instance a copy belongs to: its outermost non-expanded ancestor with `instanceOf`. */
function instanceOfCopy(compiled: CompiledDocument, copy: CompiledNode): string | undefined {
  const chain = [copy, ...[...copy.parents].reverse().map((id) => getNode(compiled, id))];
  return chain.filter((n) => n !== undefined && !n.expanded && n.instanceOf !== undefined).pop()?.id;
}

export const a11y003: Rule = (compiled: CompiledDocument, config: GatesConfig) => {
  const min = 12, hardMin = 10;
  const level = (value: number): "block" | "warn" | undefined => (value < hardMin ? "block" : value < min ? "warn" : undefined);

  const copies = new Map<string, CompiledNode[]>();
  for (const n of compiled.nodes) {
    if (!inherited(n) || n.props[PROP] === undefined) continue;
    const def = definitionOf(compiled, n);
    if (def) copies.set(def.id, [...(copies.get(def.id) ?? []), n]);
  }

  const out: Violation[] = [];
  for (const node of compiled.nodes) {
    if (node.props[PROP] === undefined || inherited(node)) continue;
    const own = sizeOf(compiled, node);
    const copyList = copies.get(node.id) ?? [];
    const candidates = [own, ...copyList.map((c) => sizeOf(compiled, c))].filter((s): s is Size => s !== undefined && level(s.value) !== undefined);
    if (candidates.length === 0) continue;
    const worst = candidates.reduce((a, b) => (b.value < a.value || (b.value === a.value && byString(b.node.themeKey, a.node.themeKey) < 0) ? b : a));
    const severity = level(worst.value)!;
    const threshold = severity === "block" ? `hardMin ${hardMin}` : `min ${min}`;
    const listed = new Set(listInstances(compiled, node.id));
    const affected = new Set<string>();
    for (const c of candidates) {
      if (c.node === node) continue;
      const id = instanceOfCopy(compiled, c.node);
      if (id !== undefined && listed.has(id)) affected.add(id);
    }
    const v: Violation = {
      rule: ID,
      severity,
      file: compiled.file,
      nodeId: node.id,
      path: node.path,
      prop: PROP,
      message: `fontSize ${worst.value}${worst.variable ? ` (${worst.variable})` : ""} is below the ${threshold}`,
      theme: worst.node.themeKey,
    };
    if (affected.size > 0) v.affectedInstances = [...affected].sort(byString);
    out.push(v);
  }
  return out.sort((a, b) => byString(a.nodeId, b.nodeId));
};
