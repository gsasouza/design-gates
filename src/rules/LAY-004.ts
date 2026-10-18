import { getNode, resolveForTheme } from "../compile/query.js";
import type { CompiledDocument, CompiledNode } from "../compile/types.js";
import type { GatesConfig } from "../gates/config.js";
import type { Rule, Violation } from "../gates/types.js";
import { globToRegExp } from "./tok-slots.js";

const ID = "LAY-004";
const PROPS = ["width", "height"] as const;
const NOT_FIXED = "size is not fixed; touch target cannot be checked statically";

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** The component definition a copy (an instance root or an expanded node) was copied from. */
const definitionOf = (compiled: CompiledDocument, node: CompiledNode): CompiledNode | undefined => {
  const id = node.source ?? node.instanceOf;
  return id === undefined ? undefined : getNode(compiled, id);
};

/** A concrete size: a finite number, or a `$variable` resolving to one in the node's effective theme. */
function fixedSize(compiled: CompiledDocument, node: CompiledNode, raw: unknown, prop: string): { value: number; variable?: string } | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? { value: raw } : undefined;
  if (typeof raw !== "string" || !raw.startsWith("$")) return undefined;
  const use = node.uses.find((u) => u.prop === prop && u.status === "ok");
  const resolved = use ?? resolveForTheme(compiled, raw, node.theme);
  if (resolved.status !== "ok" || typeof resolved.value !== "number" || !Number.isFinite(resolved.value)) return undefined;
  return { value: resolved.value, variable: use ? `$${use.name}` : raw };
}

export const lay004: Rule = (compiled: CompiledDocument, config: GatesConfig) => {
  const { min, recommended, interactive } = config.rules[ID];
  const globs = interactive.components.map(globToRegExp);
  const namePattern = new RegExp(interactive.namePattern, "i");
  const globMatch = (n: CompiledNode | undefined): boolean => n !== undefined && [n.id, n.sourceId, text(n.props.name)].some((s) => s !== undefined && globs.some((re) => re.test(s)));

  const isInteractive = (node: CompiledNode): boolean => {
    const component = node.instanceOf === undefined ? undefined : getNode(compiled, node.instanceOf);
    if (globMatch(component)) return true;
    if (!node.expanded && node.instanceOf === undefined && node.props.reusable === true && globMatch(node)) return true;
    return [text(node.props.name), text(component?.props.name)].some((s) => s !== undefined && namePattern.test(s));
  };

  const out: Violation[] = [];
  for (const node of compiled.nodes) {
    if (!isInteractive(node)) continue;
    const copy = node.expanded || node.instanceOf !== undefined;
    const definition = copy ? definitionOf(compiled, node) : undefined;
    for (const prop of PROPS) {
      const raw = node.props[prop];
      if (node.provenance[prop]?.origin === "component") continue;
      if (raw === undefined && copy && definition?.props[prop] === undefined) continue;
      const base = { rule: ID, file: compiled.file, nodeId: node.id, path: node.path, prop } as const;
      const size = raw === undefined ? undefined : fixedSize(compiled, node, raw, prop);
      if (!size) {
        out.push({ ...base, severity: "review", fixedSeverity: true, message: NOT_FIXED });
        continue;
      }
      const severity = size.value < min ? "block" : size.value < recommended ? "warn" : undefined;
      if (!severity) continue;
      const shown = `${size.value}${size.variable ? ` (${size.variable})` : ""}`;
      out.push({
        ...base,
        severity,
        message: `touch target ${prop} ${shown} is below the ${severity === "block" ? "minimum" : "recommended"} ${severity === "block" ? min : recommended}`,
        ...(size.variable ? { theme: node.themeKey } : {}),
      });
    }
  }
  return out.sort((a, b) => byString(a.nodeId, b.nodeId) || byString(a.prop ?? "", b.prop ?? ""));
};
