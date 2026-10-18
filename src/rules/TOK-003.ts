import { themeCombinations } from "../compile/query.js";
import type { CompiledDocument } from "../compile/types.js";
import type { GatesConfig } from "../gates/config.js";
import type { Violation } from "../gates/types.js";
import { themeKey } from "../diff/variables.js";
import { variableNodeId } from "../gates/variable-id.js";
import { defaultTheme, resolveVariable, type Theme } from "../render/themes.js";

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

type Entry = { value?: unknown; theme?: unknown };

const entryTheme = (e: Entry | undefined): Theme => (typeof e?.theme === "object" && e.theme !== null && !Array.isArray(e.theme) ? (e.theme as Theme) : {});

/** Declared axes with their de-duplicated string values, filtered like themeCombinations; restricted to `only` when given. */
function requiredAxes(compiled: CompiledDocument, only: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [axis, values] of Object.entries(compiled.themes ?? {})) {
    if (!Array.isArray(values) || (only.length > 0 && !only.includes(axis))) continue;
    const list = [...new Set(values.filter((v) => typeof v === "string"))];
    if (list.length > 0) out.set(axis, list);
  }
  return out;
}

const project = (theme: Theme, axes: ReadonlyMap<string, string[]>): Theme =>
  Object.fromEntries(Object.entries(theme).filter(([axis]) => axes.has(axis)));

/** Variable name -> effective themes of the nodes using it, aliases counting as use of their targets. */
function usageIndex(compiled: CompiledDocument): Map<string, Theme[]> {
  const seen = new Map<string, Map<string, Theme>>();
  for (const node of compiled.nodes) {
    for (const use of node.uses) {
      for (const name of use.chain) {
        const themes = seen.get(name) ?? new Map<string, Theme>();
        themes.set(node.themeKey, node.theme);
        seen.set(name, themes);
      }
    }
  }
  return new Map([...seen].map(([name, themes]) => [name, [...themes.values()]]));
}

/** TOK-003: themed variables without a value for a theme combination. */
export function run(compiled: CompiledDocument, config: GatesConfig): Violation[] {
  const cfg = config.rules["TOK-003"];
  const axes = requiredAxes(compiled, cfg.themeAxes);
  if (axes.size === 0) return [];
  const base = defaultTheme(compiled.themes);

  const combos = new Map<string, Theme>();
  const addCombo = (theme: Theme): void => {
    const p = project(theme, axes);
    combos.set(themeKey(p), p);
  };
  if (cfg.requireAllCombinations) {
    for (const c of themeCombinations(compiled.themes)) addCombo(c.theme);
  } else {
    for (const node of compiled.nodes) addCombo(node.theme);
    addCombo(base);
  }

  const usage = usageIndex(compiled);
  const out: Violation[] = [];
  for (const name of Object.keys(compiled.variables)) {
    const variable = compiled.variables[name];
    if (!variable || !Array.isArray(variable.value)) continue;
    const entries = variable.value as Entry[];
    const used = usage.get(name) ?? [];
    const found = new Map<string, boolean>();
    const add = (prop: string, isUsed: boolean): void => {
      if (!found.has(prop)) found.set(prop, isUsed);
    };

    for (const [key, combo] of combos) {
      if (resolveVariable(variable, { ...base, ...combo }) !== undefined) continue;
      add(key, used.some((t) => Object.entries(combo).every(([axis, v]) => t[axis] === v)));
    }
    for (const [axis, values] of axes) {
      const varies = entries.some((e) => axis in entryTheme(e));
      if (!varies || entries.some((e) => !(axis in entryTheme(e)))) continue;
      for (const v of values) {
        if (entries.some((e) => entryTheme(e)[axis] === v)) continue;
        add(`${axis}=${v}`, used.some((t) => t[axis] === v));
      }
    }

    for (const [prop, isUsed] of found) {
      out.push({
        rule: "TOK-003",
        severity: isUsed ? "block" : "warn",
        file: compiled.file,
        nodeId: variableNodeId(name),
        path: variableNodeId(name),
        prop,
        message: `Variable $${name} has no value for ${prop}`,
        theme: prop,
      });
    }
  }
  return out.sort((a, b) => cmp(a.nodeId, b.nodeId) || cmp(a.prop ?? "", b.prop ?? ""));
}
