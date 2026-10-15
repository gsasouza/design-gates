import { themeKey } from "../diff/variables.js";
import type { PenThemes } from "../pen/types.js";
import { resolveAlias, type ResolveResult, type Theme } from "../render/themes.js";
import { MAX_THEME_COMBINATIONS } from "./constants.js";
import type { CompiledDocument, CompiledNode } from "./types.js";

interface Index {
  byId: Map<string, CompiledNode>;
  instances: Map<string, string[]>;
}

const indexes = new WeakMap<CompiledDocument, Index>();

function indexOf(compiled: CompiledDocument): Index {
  let index = indexes.get(compiled);
  if (index) return index;
  const byId = new Map(compiled.nodes.map((n) => [n.id, n] as const));
  const direct = new Map<string, string[]>();
  for (const n of compiled.nodes) {
    if (n.instanceOf !== undefined) direct.set(n.instanceOf, [...(direct.get(n.instanceOf) ?? []), n.id]);
  }
  /** Instances of `id`, plus instances of every component that holds an instance of it. */
  const collect = (id: string, visiting: Set<string>, out: Set<string>): void => {
    if (visiting.has(id)) return;
    visiting.add(id);
    for (const instanceId of direct.get(id) ?? []) {
      out.add(instanceId);
      const inst = byId.get(instanceId);
      if (!inst || inst.expanded) continue;
      const holder = [...inst.parents].reverse().map((p) => byId.get(p)).find((p) => p?.props.reusable === true);
      if (holder) collect(holder.id, visiting, out);
    }
  };
  const instances = new Map<string, string[]>();
  for (const n of compiled.nodes) {
    if (n.props.reusable !== true || n.expanded) continue;
    const out = new Set<string>();
    collect(n.id, new Set(), out);
    instances.set(n.id, [...out].sort());
  }
  index = { byId, instances };
  indexes.set(compiled, index);
  return index;
}

export function getNode(compiled: CompiledDocument, id: string): CompiledNode | undefined {
  return indexOf(compiled).byId.get(id);
}

/** Compiled nodes in document (pre-order) order. */
export function* iterateNodes(compiled: CompiledDocument): Generator<CompiledNode> {
  yield* compiled.nodes;
}

/** Reusable components defined in the document, sorted by id. */
export function listComponents(compiled: CompiledDocument): CompiledNode[] {
  return compiled.nodes.filter((n) => n.props.reusable === true && !n.expanded).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Sorted ids of the instances of a component, including instances of components that contain one. */
export function listInstances(compiled: CompiledDocument, componentId: string): string[] {
  return [...(indexOf(compiled).instances.get(componentId) ?? [])];
}

/** The top-level node containing `nodeId`. */
export function topFrameOf(compiled: CompiledDocument, nodeId: string): CompiledNode | undefined {
  const node = getNode(compiled, nodeId);
  return node && getNode(compiled, node.topFrameId);
}

export interface ThemeCombination {
  theme: Theme;
  /** `axis=value,axis=value` with axes sorted, or `default` when there are no axes. */
  key: string;
}

/** Cartesian product of the declared theme axes, sorted by key. At most MAX_THEME_COMBINATIONS. */
export function themeCombinations(themes: PenThemes | undefined): ThemeCombination[] {
  const axes = Object.entries(themes ?? {})
    .filter(([, values]) => Array.isArray(values) && values.length > 0)
    .map(([axis, values]) => [axis, [...new Set(values.filter((v) => typeof v === "string"))]] as const)
    .filter(([, values]) => values.length > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  let combos: Theme[] = [{}];
  for (const [axis, values] of axes) {
    combos = combos.flatMap((c) => values.map((v) => ({ ...c, [axis]: v }))).slice(0, MAX_THEME_COMBINATIONS * 4);
  }
  return combos
    .map((theme) => ({ theme, key: themeKey(theme) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, MAX_THEME_COMBINATIONS);
}

/** Resolve a `$name` reference for a given theme with the shared resolver. */
export function resolveForTheme(compiled: CompiledDocument, ref: string, theme: Theme): ResolveResult {
  return resolveAlias(ref, compiled.variables, theme);
}
