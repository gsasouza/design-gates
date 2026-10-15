import type { PenDocument, PenNode, PenVariable } from "../pen/types.js";
import { isVariableRef } from "../render/themes.js";
import type { DiffDocs, FrameRef, ThemeChange, VariableChange } from "./model.js";

export interface VariablesDiff {
  variables: VariableChange[];
  themes: ThemeChange[];
}

function themeKey(theme: Record<string, string> | undefined): string {
  const pairs = Object.entries(theme ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return pairs.length ? pairs.map(([k, v]) => `${k}=${v}`).join(",") : "default";
}

/** Value per theme key: themed entries by their theme, a plain value as "default". */
function valuesByTheme(variable: PenVariable): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (!Array.isArray(variable.value)) return out.set("default", variable.value);
  for (const e of variable.value as { value: unknown; theme?: Record<string, string> }[]) out.set(themeKey(e.theme), e.value);
  return out;
}

function findById(nodes: PenNode[], id: string): PenNode | undefined {
  for (const n of nodes) {
    const found = n.id === id ? n : n.children && findById(n.children, id);
    if (found) return found;
  }
  return undefined;
}

/** Variable names a subtree references: `$name` strings anywhere, plus those of instanced components. */
function referencedNames(doc: PenDocument, node: PenNode, visiting: Set<string> = new Set()): Set<string> {
  const names = new Set<string>();
  const walk = (value: unknown, key?: string): void => {
    if (isVariableRef(key, value)) names.add(value.slice(1));
    else if (Array.isArray(value)) value.forEach((v) => walk(v, key));
    else if (typeof value === "object" && value !== null) Object.entries(value).forEach(([k, v]) => walk(v, k));
  };
  walk(node);
  const instances: string[] = [];
  const findRefs = (n: PenNode): void => {
    if (typeof n.ref === "string") instances.push(n.ref);
    n.children?.forEach(findRefs);
  };
  findRefs(node);
  for (const ref of instances) {
    const comp = findById(doc.children, ref);
    if (!comp || visiting.has(comp.id)) continue;
    visiting.add(comp.id);
    for (const n of referencedNames(doc, comp, visiting)) names.add(n);
  }
  return names;
}

/** `name` plus every variable whose value (any theme entry, transitively) is an alias `$name`. */
function aliasClosure(doc: PenDocument, name: string): Set<string> {
  const out = new Set([name]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [other, variable] of Object.entries(doc.variables ?? {})) {
      if (out.has(other)) continue;
      const values = Array.isArray(variable.value) ? (variable.value as { value: unknown }[]).map((e) => e.value) : [variable.value];
      if (values.some((v) => isVariableRef(undefined, v) && out.has(v.slice(1)))) grew = out.add(other).size > 0;
    }
  }
  return out;
}

const frameNames = new WeakMap<PenDocument, [PenNode, Set<string>][]>();

/** Each top-level frame with the variable names it references, computed once per document. */
function framesWithNames(doc: PenDocument): [PenNode, Set<string>][] {
  let cached = frameNames.get(doc);
  if (!cached) frameNames.set(doc, (cached = doc.children.map((f) => [f, referencedNames(doc, f)])));
  return cached;
}

function framesReferencing(file: string, doc: PenDocument | undefined, name: string): FrameRef[] {
  if (!doc) return [];
  const targets = aliasClosure(doc, name);
  return framesWithNames(doc)
    .filter(([, names]) => [...names].some((n) => targets.has(n)))
    .map(([f]) => ({ file, frameId: f.id }));
}

function framesPinningAxis(file: string, doc: PenDocument | undefined, axis: string): FrameRef[] {
  if (!doc) return [];
  const pins = (n: PenNode): boolean => (n.theme !== undefined && axis in n.theme) || (n.children ?? []).some(pins);
  return doc.children.filter(pins).map((f) => ({ file, frameId: f.id }));
}

function mergeFrames(...lists: FrameRef[][]): FrameRef[] {
  const map = new Map<string, FrameRef>();
  for (const r of lists.flat()) map.set(`${r.file}\0${r.frameId}`, r);
  return [...map.values()].sort((a, b) => (a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.frameId < b.frameId ? -1 : a.frameId > b.frameId ? 1 : 0));
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const themeOrder = (t: string | undefined): string => (t === undefined || t === "default" ? "" : t);

/** Variable and theme-axis changes between the base and head document of every file. */
export function diffVariables(docs: DiffDocs): VariablesDiff {
  const variables: VariableChange[] = [];
  const themes: ThemeChange[] = [];
  for (const file of Object.keys(docs).sort(cmp)) {
    const { base, head } = docs[file]!;
    const baseVars = base?.variables ?? {};
    const headVars = head?.variables ?? {};
    for (const name of new Set([...Object.keys(baseVars), ...Object.keys(headVars)])) {
      const b = baseVars[name] && valuesByTheme(baseVars[name]!);
      const h = headVars[name] && valuesByTheme(headVars[name]!);
      const change = !b ? "added" : !h ? "removed" : "modified";
      const frames = mergeFrames(
        change !== "added" ? framesReferencing(file, base, name) : [],
        change !== "removed" ? framesReferencing(file, head, name) : [],
      );
      for (const theme of new Set([...(b?.keys() ?? []), ...(h?.keys() ?? [])])) {
        const old = b?.get(theme);
        const next = h?.get(theme);
        if (change === "modified" && JSON.stringify(old) === JSON.stringify(next)) continue;
        const c: VariableChange = { file, name, change, theme, frames };
        if (b?.has(theme)) c.old = old;
        if (h?.has(theme)) c.new = next;
        variables.push(c);
      }
    }
    const baseAxes = Object.keys(base?.themes ?? {});
    const headAxes = Object.keys(head?.themes ?? {});
    for (const axis of baseAxes.filter((a) => !headAxes.includes(a))) {
      themes.push({ file, name: axis, change: "removed", frames: mergeFrames(framesPinningAxis(file, base, axis)) });
    }
    for (const axis of headAxes.filter((a) => !baseAxes.includes(a))) {
      themes.push({ file, name: axis, change: "added", frames: mergeFrames(framesPinningAxis(file, head, axis)) });
    }
  }
  variables.sort((a, b) => cmp(a.file, b.file) || cmp(a.name, b.name) || cmp(themeOrder(a.theme), themeOrder(b.theme)));
  themes.sort((a, b) => cmp(a.file, b.file) || cmp(a.name, b.name));
  return { variables, themes };
}
