import { controlledProp } from "./tok.js";
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
  /** Per property, literal values never reported; a `/.../` string is a regular expression. */
  ignoreValues: Record<string, string[]>;
  /** Top-level frame names or ids to check (`*` glob); empty = all frames. */
  onlyIn: string[];
}

export const SCALE_CATEGORIES = ["fontSize", "radius", "spacing", "strokeWidth"] as const;
export type ScaleCategory = (typeof SCALE_CATEGORIES)[number];
export type Scale = { base: number } | number[];

export interface Tok002Config extends RuleConfig {
  /** Allowed values per category: `{ base: n }` (multiples of n) or an explicit list. */
  scales: Record<ScaleCategory, Scale>;
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
  /** Component ids/names or variable names (`*` glob) whose block is downgraded to warn. */
  scope: string[];
}

export interface GatesConfig {
  /** Colour assumed behind the top-level frames when computing contrast. */
  canvasColor: string;
  /** Escalates only the rules that say so (TOK-002 warn -> block); the CLI still fails only on block. */
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
    "DIF-001": { warnAt: 5, blockAt: 20, scope: [] },
    "SCH-001": {},
    "SCH-002": {},
    "SCH-003": {},
    "TOK-001": { properties: ["fill", "stroke", "effect.color", "cornerRadius", "gap", "padding", "fontSize", "strokeWidth", "fontFamily"], ignoreValues: {}, onlyIn: [] },
    "TOK-002": {
      scales: {
        fontSize: [12, 14, 16, 20, 24, 32, 40, 48],
        radius: { base: 2 },
        spacing: { base: 4 },
        strokeWidth: [1, 2, 4],
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
const properties: Check = (v) =>
  isStringList(v) ? (v.every((p) => controlledProp(p)) ? undefined : "must only list controlled properties") : "must be an array of strings";
const number = (min: number): Check => (v) => (isNumber(v, min) ? undefined : `must be a number >= ${min}`);
const integer = (min: number): Check => (v) => (isNumber(v, min) && Number.isInteger(v) ? undefined : `must be an integer >= ${min}`);
const isScale = (v: unknown): boolean =>
  Array.isArray(v) ? v.every((n) => isNumber(n, -Infinity)) : isObject(v) && Object.keys(v).length === 1 && typeof v.base === "number" && Number.isFinite(v.base) && v.base > 0;
const scales: Check = (v) =>
  isObject(v) && Object.entries(v).every(([k, s]) => (SCALE_CATEGORIES as readonly string[]).includes(k) && isScale(s))
    ? undefined
    : `must be an object with categories ${SCALE_CATEGORIES.join(", ")}, each { "base": n } or an array of numbers`;
const ignoreValues: Check = (v) => {
  if (!isObject(v) || !Object.values(v).every(isStringList)) return "must be an object of string arrays keyed by property";
  for (const list of Object.values(v) as string[][]) {
    for (const s of list) {
      if (s.length > 2 && s.startsWith("/") && s.endsWith("/")) {
        try {
          new RegExp(s.slice(1, -1));
        } catch {
          return `has an invalid regular expression ${s}`;
        }
      }
    }
  }
  return undefined;
};

/** Validators for the option keys each rule knows; other keys are kept untouched. */
const OPTION_CHECKS: Partial<Record<RuleId, Record<string, Check>>> = {
  "A11Y-001": { minRatio: number(1), minRatioLarge: number(1) },
  "CMP-001": { minNodes: integer(1) },
  "DIF-001": { warnAt: number(0), blockAt: number(0), scope: stringList },
  "TOK-001": { properties, ignoreValues, onlyIn: stringList },
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
