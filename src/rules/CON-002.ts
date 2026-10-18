import type { CompiledDocument } from "../compile/types.js";
import type { ContractTokens, TokenValues } from "../contract/data.js";
import { themeKey } from "../diff/variables.js";
import { variableNodeId } from "../gates/variable-id.js";
import { normalizeColor } from "../gates/tok.js";
import type { Rule, Violation } from "../gates/types.js";
import { defaultTheme, isVariableRef, resolveAlias, type Theme } from "../render/themes.js";
import { sortViolations } from "./cnt-text.js";

const MAX_VAR_DEPTH = 32;
const CSS_VAR = /^var\(\s*(--[^\s,)]+)\s*(?:,\s*([\s\S]*))?\)$/;

/** Maps a .pen variable name to the code token key (`kebab-css`: `--color-background`; `dtcg-path`: `color.background`). */
export function tokenName(name: string, transform: string): string {
  const parts = name.split(/[./]/);
  return transform === "dtcg-path" ? parts.join(".") : `--${parts.join("-")}`;
}

/** Follows `var(--x[, fallback])` through the theme table, then the default one; the raw text when it cannot be resolved. */
function resolveCssVar(raw: string, table: TokenValues | undefined, base: TokenValues | undefined): string {
  let value = raw.trim();
  for (let depth = 0; depth < MAX_VAR_DEPTH; depth++) {
    const m = CSS_VAR.exec(value);
    if (!m) break;
    const next = table?.get(m[1]!) ?? base?.get(m[1]!) ?? m[2];
    if (next === undefined) break;
    value = next.trim();
  }
  return value;
}

const NUMERIC = /^-?(?:\d+\.?\d*|\.\d+)(?:px)?$/;

function sameValue(design: string | number, code: string): boolean {
  if (typeof design === "number") return NUMERIC.test(code) ? parseFloat(code) === design : String(design) === code;
  const color = normalizeColor(design.trim());
  if (color !== undefined) return color === normalizeColor(code);
  return design.trim() === code;
}

type Entry = { value?: unknown; theme?: unknown };

/** CON-002: a document variable whose value differs from, or has no counterpart in, the code token table (opt-in). */
export const con002: Rule = (compiled: CompiledDocument, config, _diff, contract) => {
  const tokens: ContractTokens | undefined = contract?.tokens;
  if (!tokens) return [];
  const transform = config.rules["CON-002"].nameTransform;
  const base = tokens.byTheme.get("");
  const defaults = defaultTheme(compiled.themes);
  const out: Violation[] = [];
  for (const [name, variable] of Object.entries(compiled.variables)) {
    const entries: Entry[] = Array.isArray(variable.value) ? (variable.value as Entry[]) : [{ value: variable.value }];
    const found = new Map<string, Violation>();
    for (const entry of entries) {
      const theme: Theme = typeof entry.theme === "object" && entry.theme !== null && !Array.isArray(entry.theme) ? (entry.theme as Theme) : {};
      const key = Object.keys(theme).length > 0 ? themeKey(theme) : "";
      const table = tokens.byTheme.get(key);
      if (!table) continue;
      let value = entry.value;
      if (isVariableRef(undefined, value)) {
        const r = resolveAlias(value, compiled.variables, { ...defaults, ...theme });
        if (r.status !== "ok") continue;
        value = r.value;
      }
      if (typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value))) continue;
      const token = tokenName(name, transform);
      const prop = key === "" ? "value" : `value[${key}]`;
      const raw = table.get(token) ?? base?.get(token);
      const where = key === "" ? "" : ` in ${key}`;
      const common = { rule: "CON-002", file: compiled.file, nodeId: variableNodeId(name), path: variableNodeId(name), prop, ...(key === "" ? {} : { theme: key }) };
      if (raw === undefined) {
        found.set(prop, { ...common, severity: "warn", message: `Variable $${name}${where} has no code token ${token} (design value ${JSON.stringify(value)})` });
        continue;
      }
      const code = resolveCssVar(raw, table, base);
      if (sameValue(value, code)) found.delete(prop);
      else found.set(prop, { ...common, severity: "block", message: `Variable $${name}${where} is ${JSON.stringify(value)} in design but code token ${token} is ${JSON.stringify(code)}` });
    }
    out.push(...found.values());
  }
  return sortViolations(out);
};
