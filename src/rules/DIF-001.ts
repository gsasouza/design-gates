import { getNode, listComponents, listInstances, resolveForTheme, topFrameOf } from "../compile/query.js";
import type { CompiledDocument, CompiledNode } from "../compile/types.js";
import type { Dif001Config } from "../gates/config.js";
import type { Rule, Severity, Violation } from "../gates/types.js";

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function canonical(value: unknown, depth = 0): unknown {
  if (depth > 64) return "…";
  if (Array.isArray(value)) return value.map((v) => canonical(v, depth + 1));
  if (typeof value !== "object" || value === null) return value ?? null;
  return Object.keys(value).sort(cmp).map((k) => [k, canonical((value as Record<string, unknown>)[k], depth + 1)]);
}

/**
 * Source-level signature of a component: for every node below it (nested components excluded, they
 * are compared on their own) its type, child ids and the props it sets itself. Props copied from
 * another component are left out, so a change inside nested B is not also a change of A.
 */
function signature(compiled: CompiledDocument, component: CompiledNode): string {
  const rows: [string, unknown][] = [];
  const walk = (node: CompiledNode, depth: number): void => {
    const own = Object.entries(node.props).filter(([k]) => (node.expanded ? node.provenance[k]?.origin === "instance" : node.provenance[k]?.origin !== "component"));
    const sourceChildren = node.children.map((id) => getNode(compiled, id)).filter((c): c is CompiledNode => c !== undefined && !c.expanded);
    // an expanded node belongs to the nested component; only the overrides set here count
    if (!node.expanded) rows.push([node.path, [node.type, own.map(([k, v]) => [k, canonical(v)]), sourceChildren.map((c) => c.sourceId)]]);
    else if (own.length) rows.push([node.path, own.map(([k, v]) => [k, canonical(v)])]);
    if (depth >= 128) return;
    for (const id of node.children) {
      const child = getNode(compiled, id);
      if (child && !(child.props.reusable === true && !child.expanded)) walk(child, depth + 1);
    }
  };
  walk(component, 0);
  return JSON.stringify(rows.map(([path, row]) => [path.slice(component.path.length), row]));
}

function matchesScope(scope: readonly string[], ...names: (string | undefined)[]): boolean {
  return scope.some((pattern) => {
    const re = new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    return names.some((n) => n !== undefined && re.test(n));
  });
}

function severityFor(count: number, config: Dif001Config, names: (string | undefined)[]): Severity | undefined {
  if (count < config.warnAt) return undefined;
  return count >= config.blockAt && !matchesScope(config.scope, ...names) ? "block" : "warn";
}

function screensOf(compiled: CompiledDocument, ids: Iterable<string>): string[] {
  return [...new Set([...ids].map((id) => topFrameOf(compiled, id)).filter((f): f is CompiledNode => f !== undefined && f.props.reusable !== true).map((f) => f.id))].sort(cmp);
}

function themeMatches(node: CompiledNode, key: string): boolean {
  if (key === "default") return true;
  return key.split(",").every((pair) => {
    const i = pair.indexOf("=");
    return node.theme[pair.slice(0, i)] === pair.slice(i + 1);
  });
}

export const dif001: Rule = (compiled, config, diff) => {
  const base = diff?.base;
  if (!diff || !base) return [];
  const rule = config.rules["DIF-001"];
  const out: Violation[] = [];

  const baseSignatures = new Map(listComponents(base).map((c) => [c.id, signature(base, c)] as const));
  for (const component of listComponents(compiled)) {
    const before = baseSignatures.get(component.id);
    if (before === undefined || before === signature(compiled, component)) continue;
    const instances = listInstances(compiled, component.id);
    const severity = severityFor(instances.length, rule, [component.id, component.sourceId, typeof component.props.name === "string" ? component.props.name : undefined]);
    if (!severity) continue;
    const screens = screensOf(compiled, instances);
    out.push({
      rule: "DIF-001",
      severity,
      file: compiled.file,
      nodeId: component.id,
      path: component.path,
      message: `Component "${component.id}" changed: ${instances.length} instances in ${screens.length} screens${screens.length ? ` (${screens.join(", ")})` : ""}`,
      affectedInstances: instances,
    });
  }

  const names = [...new Set((diff.variables?.variables ?? []).map((v) => v.name))].sort(cmp);
  for (const name of names) {
    const keys = [...new Set((diff.variables?.variables ?? []).filter((v) => v.name === name).map((v) => v.theme ?? "default"))].sort(cmp);
    const perTheme = new Map<string, number>();
    const all = new Set<string>();
    for (const node of compiled.nodes) {
      const changed = node.uses.some((u) => u.chain.includes(name) && JSON.stringify(canonical(u.value)) !== JSON.stringify(canonical(resolveForTheme(base, `$${u.name}`, node.theme).value)));
      if (!changed) continue;
      for (const key of keys) {
        if (!themeMatches(node, key)) continue;
        perTheme.set(key, (perTheme.get(key) ?? 0) + 1);
        all.add(node.id);
      }
    }
    const severity = severityFor(all.size, rule, [`$${name}`, name]);
    if (!severity) continue;
    const screens = screensOf(compiled, all);
    const counts = [...perTheme].sort(([a], [b]) => cmp(a, b)).map(([k, n]) => `${k}: ${n} nodes`);
    out.push({
      rule: "DIF-001",
      severity,
      file: compiled.file,
      nodeId: `$${name}`,
      path: `$${name}`,
      message: `Variable $${name} changed: ${counts.join(", ")}; ${all.size} nodes in ${screens.length} screens${screens.length ? ` (${screens.join(", ")})` : ""}`,
    });
  }

  for (const change of (diff.variables?.themes ?? []).filter((t) => t.file === compiled.file)) {
    const doc = change.change === "removed" ? base : compiled;
    const perValue = new Map<string, number>();
    const all = new Set<string>();
    for (const node of doc.nodes) {
      const pin = node.props.theme;
      const value = typeof pin === "object" && pin !== null ? (pin as Record<string, unknown>)[change.name] : undefined;
      if (typeof value !== "string") continue;
      const key = `${change.name}=${value}`;
      perValue.set(key, (perValue.get(key) ?? 0) + 1);
      all.add(node.id);
    }
    const severity = severityFor(all.size, rule, [`theme:${change.name}`, change.name]);
    if (!severity) continue;
    const screens = screensOf(doc, all);
    const counts = [...perValue].sort(([a], [b]) => cmp(a, b)).map(([k, n]) => `${k}: ${n} nodes`);
    out.push({
      rule: "DIF-001",
      severity,
      file: compiled.file,
      nodeId: `theme:${change.name}`,
      path: `theme:${change.name}`,
      message: `Theme ${change.name} ${change.change}: ${counts.join(", ")}; ${all.size} nodes in ${screens.length} screens${screens.length ? ` (${screens.join(", ")})` : ""}`,
    });
  }
  return out.sort((a, b) => cmp(a.nodeId, b.nodeId));
};
