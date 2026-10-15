import type { Severity } from "./types.js";

export const RULE_IDS = ["A11Y-001", "CMP-001", "DIF-001", "SCH-001", "SCH-002", "SCH-003", "TOK-001", "TOK-002"] as const;
export type RuleId = (typeof RULE_IDS)[number];

export type SeverityOverride = Severity | "off";

/** Options every rule accepts. Unknown keys are kept so later cards can extend a rule's bag. */
export interface RuleConfig {
  severity?: SeverityOverride;
  [key: string]: unknown;
}

export interface Tok001Config extends RuleConfig {
  /** Properties checked for hard-coded values (dotted paths, e.g. `stroke.fill`). */
  properties: string[];
  /** Literal values never reported. */
  ignoreValues: string[];
  /** Top-level frame names or ids to check (`*` glob); empty = all frames. */
  onlyIn: string[];
}

export interface Tok002Config extends RuleConfig {
  /** Allowed values per scale name. */
  scales: Record<string, number[]>;
  /** Distance from a scale value still accepted. */
  tolerance: number;
}

export interface A11y001Config extends RuleConfig {
  minRatio: number;
  minRatioLarge: number;
}

export interface Cmp001Config extends RuleConfig {
  minNodes: number;
}

export interface Dif001Config extends RuleConfig {
  warnAt: number;
  blockAt: number;
  /** Frame names or ids counted (`*` glob). */
  scope: string[];
}

export interface GatesConfig {
  /** Colour assumed behind the top-level frames when computing contrast. */
  canvasColor: string;
  /** Treat warnings as failures (applied by the CLI). */
  strict: boolean;
  rules: {
    "A11Y-001": A11y001Config;
    "CMP-001": Cmp001Config;
    "DIF-001": Dif001Config;
    "SCH-001": RuleConfig;
    "SCH-002": RuleConfig;
    "SCH-003": RuleConfig;
    "TOK-001": Tok001Config;
    "TOK-002": Tok002Config;
  };
}

export const DEFAULT_CONFIG: GatesConfig = {
  canvasColor: "#FFFFFF",
  strict: false,
  rules: {
    "A11Y-001": { minRatio: 4.5, minRatioLarge: 3 },
    "CMP-001": { minNodes: 3 },
    "DIF-001": { warnAt: 5, blockAt: 20, scope: ["*"] },
    "SCH-001": {},
    "SCH-002": {},
    "SCH-003": {},
    "TOK-001": { properties: ["fill", "stroke.fill"], ignoreValues: [], onlyIn: [] },
    "TOK-002": {
      scales: {
        fontSize: [12, 14, 16, 20, 24, 32, 40, 48],
        radius: [0, 2, 4, 8, 12, 16, 24],
        spacing: [0, 2, 4, 8, 12, 16, 24, 32, 48, 64],
      },
      tolerance: 0,
    },
  },
};

export type ConfigResult = { config: GatesConfig } | { error: string };

const SEVERITIES = ["block", "warn", "review", "info", "off"];
const COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
const isNumber = (v: unknown, min: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= min;

type Check = (value: unknown) => string | undefined;
const stringList: Check = (v) => (isStringList(v) ? undefined : "must be an array of strings");
const number = (min: number): Check => (v) => (isNumber(v, min) ? undefined : `must be a number >= ${min}`);
const integer = (min: number): Check => (v) => (isNumber(v, min) && Number.isInteger(v) ? undefined : `must be an integer >= ${min}`);
const scales: Check = (v) =>
  isObject(v) && Object.values(v).every((l) => Array.isArray(l) && l.every((n) => isNumber(n, -Infinity)))
    ? undefined
    : "must be an object of number arrays";

/** Validators for the option keys each rule knows; other keys are kept untouched. */
const OPTION_CHECKS: Partial<Record<RuleId, Record<string, Check>>> = {
  "A11Y-001": { minRatio: number(1), minRatioLarge: number(1) },
  "CMP-001": { minNodes: integer(1) },
  "DIF-001": { warnAt: number(0), blockAt: number(0), scope: stringList },
  "TOK-001": { properties: stringList, ignoreValues: stringList, onlyIn: stringList },
  "TOK-002": { scales, tolerance: number(0) },
};

function resolveRule(id: RuleId, raw: unknown): RuleConfig | string {
  if (!isObject(raw)) return `rules.${id} must be an object`;
  const out: Record<string, unknown> = { ...structuredClone(DEFAULT_CONFIG.rules[id]) };
  for (const [key, value] of Object.entries(raw)) {
    const check = key === "severity" ? (v: unknown) => (typeof v === "string" && SEVERITIES.includes(v) ? undefined : `must be one of ${SEVERITIES.join(", ")}`) : OPTION_CHECKS[id]?.[key];
    const problem = check?.(value);
    if (problem) return `rules.${id}.${key} ${problem}`;
    Object.defineProperty(out, key, { value: structuredClone(value), enumerable: true, writable: true, configurable: true });
  }
  if (id === "DIF-001" && (out.warnAt as number) > (out.blockAt as number)) return "rules.DIF-001.warnAt must not exceed blockAt";
  return out as RuleConfig;
}

/** Validate a parsed `design-gates.config.json` and fill in defaults. Never throws. */
export function resolveConfig(raw: unknown): ConfigResult {
  const config = structuredClone(DEFAULT_CONFIG);
  if (raw === undefined || raw === null) return { config };
  if (!isObject(raw)) return { error: "config must be an object" };
  for (const key of Object.keys(raw)) {
    if (key !== "canvasColor" && key !== "strict" && key !== "rules") return { error: `unknown config key "${key}"` };
  }
  if (raw.canvasColor !== undefined) {
    if (typeof raw.canvasColor !== "string" || !COLOR.test(raw.canvasColor)) return { error: "canvasColor must be a hex colour such as #FFFFFF" };
    config.canvasColor = raw.canvasColor;
  }
  if (raw.strict !== undefined) {
    if (typeof raw.strict !== "boolean") return { error: "strict must be a boolean" };
    config.strict = raw.strict;
  }
  if (raw.rules !== undefined) {
    if (!isObject(raw.rules)) return { error: "rules must be an object" };
    for (const [id, value] of Object.entries(raw.rules)) {
      if (!(RULE_IDS as readonly string[]).includes(id)) return { error: `unknown rule "${id}"` };
      const rule = resolveRule(id as RuleId, value);
      if (typeof rule === "string") return { error: rule };
      (config.rules as Record<string, RuleConfig>)[id] = rule;
    }
  }
  return { config };
}
