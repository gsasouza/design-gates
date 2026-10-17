import type { Violation } from "../gates/types.js";

export const BASELINE_FILE = "design-gates-baseline.json";

export interface BaselineEntry {
  file: string;
  rule: string;
  nodeId: string;
  prop: string;
  theme: string;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function entryOf(v: Violation): BaselineEntry {
  return { file: v.file, rule: v.rule, nodeId: v.nodeId, prop: v.prop ?? "", theme: v.theme ?? "" };
}

/**
 * Rules that took over findings of another rule: a violation of the key also counts as baselined when the
 * baseline holds the same file, nodeId, prop and theme under one of the listed rules (TOK-005 reports the
 * slots TOK-001 used to report). The baseline file format is unchanged; `--update-baseline` writes the current rule id.
 */
export const RULE_ALIASES: Readonly<Record<string, readonly string[]>> = { "TOK-005": ["TOK-001"] };

export const fingerprint = (e: BaselineEntry): string => JSON.stringify([e.file, e.rule, e.nodeId, e.prop, e.theme]);

/** Parses a baseline file into its fingerprints; throws on an invalid shape. */
export function parseBaseline(text: string): Set<string> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid ${BASELINE_FILE}: ${(err as Error).message}`);
  }
  const entries = (data as { entries?: unknown } | null)?.entries;
  if (typeof data !== "object" || data === null || !Array.isArray(entries)) throw new Error(`invalid ${BASELINE_FILE}: expected { "version": 1, "entries": [...] }`);
  const out = new Set<string>();
  for (const e of entries as Record<string, unknown>[]) {
    const ok = typeof e === "object" && e !== null && ["file", "rule", "nodeId"].every((k) => typeof e[k] === "string") &&
      ["prop", "theme"].every((k) => e[k] === undefined || typeof e[k] === "string");
    if (!ok) throw new Error(`invalid ${BASELINE_FILE}: every entry needs string file, rule and nodeId`);
    out.add(fingerprint({ file: e.file as string, rule: e.rule as string, nodeId: e.nodeId as string, prop: (e.prop as string | undefined) ?? "", theme: (e.theme as string | undefined) ?? "" }));
  }
  return out;
}

/** Sorted, de-duplicated baseline of the given violations, with a trailing newline. */
export function serializeBaseline(violations: Violation[]): string {
  const unique = new Map(violations.map((v) => [fingerprint(entryOf(v)), entryOf(v)]));
  const entries = [...unique.values()].sort(
    (a, b) => cmp(a.file, b.file) || cmp(a.rule, b.rule) || cmp(a.nodeId, b.nodeId) || cmp(a.prop, b.prop) || cmp(a.theme, b.theme),
  );
  return `${JSON.stringify({ version: 1, entries }, null, 2)}\n`;
}

/** True when the baseline holds the violation's own fingerprint or that of a rule it is an alias of. */
export function isBaselined(known: ReadonlySet<string>, v: Violation): boolean {
  const e = entryOf(v);
  return [e.rule, ...(RULE_ALIASES[e.rule] ?? [])].some((rule) => known.has(fingerprint({ ...e, rule })));
}
