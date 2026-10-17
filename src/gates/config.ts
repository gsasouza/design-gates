import { CONTROLLED_PROPS, hasNestedQuantifier, isControlledProp, MAX_IGNORE_LENGTH } from "./tok.js";
import type { Severity } from "./types.js";

export const RULE_IDS = ["A11Y-001", "CMP-001", "DIF-001", "RSP-001", "SCH-001", "SCH-002", "SCH-003", "STA-001", "TOK-001", "TOK-002"] as const;
export type RuleId = (typeof RULE_IDS)[number];

/** Rules that run only when the user's config has a `rules.<ID>` entry. */
export const OPT_IN_RULES: readonly RuleId[] = ["RSP-001", "STA-001"];

export type SeverityOverride = Severity | "off";

/** Options every rule accepts. Unknown keys are kept so later cards can extend a rule's bag. */
export interface RuleConfig {
  severity?: SeverityOverride;
  /** Set by resolveConfig for an opt-in rule the user configured; never written by the user. */
  enabled?: boolean;
  [key: string]: unknown;
}

export interface Tok001Config extends RuleConfig {
  /** Properties checked for hard-coded values: any of fill, stroke, effect.color, cornerRadius, gap, padding, fontSize, strokeWidth, fontFamily. */
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

export interface Sta001Config extends RuleConfig {
  /** State names every declaring screen or component needs a variant for. */
  states: string[];
  /** Screen or component names/ids (`*` glob) that declare data without a metadata marker. */
  screens: string[];
  /** Variant name; `{name}` is the base name, `{state}` the state. */
  pattern: string;
}

/** A breakpoint: a bare name, or a name with the frame width it expects. */
export type BreakpointEntry = string | { name: string; width?: number };

export interface Rsp001Config extends RuleConfig {
  /** Breakpoints every screen needs a frame for; required and non-empty when the rule is configured. */
  breakpoints: BreakpointEntry[];
  /** Screen names/ids (`*` glob) to check; empty = all screens. */
  screens: string[];
  /** Variant name; `{name}` is the base name, `{breakpoint}` the breakpoint name. */
  pattern: string;
  /** Breakpoint the unsuffixed base frame stands for. */
  baseBreakpoint?: string;
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
    "RSP-001": Rsp001Config;
    "SCH-001": RuleConfig;
    "SCH-002": RuleConfig;
    "SCH-003": RuleConfig;
    "STA-001": Sta001Config;
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
    "RSP-001": { enabled: false, breakpoints: [], screens: [], pattern: "{name} @ {breakpoint}" },
    "SCH-001": {},
    "SCH-002": {},
    "SCH-003": {},
    "STA-001": { enabled: false, states: ["empty", "error", "loading"], screens: [], pattern: "{name} / {state}" },
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
        if (hasNestedQuantifier(s.slice(1, -1))) return `has a regular expression with nested quantifiers ${s}`;
        if (s.length > MAX_IGNORE_LENGTH) return `has a regular expression longer than ${MAX_IGNORE_LENGTH} characters`;
      }
    }
  }
  return undefined;
};

const properties: Check = (v) =>
  isStringList(v) && v.every(isControlledProp) ? undefined : `must be an array of ${CONTROLLED_PROPS.join(", ")}`;

const states: Check = (v) => (isStringList(v) && v.length > 0 && v.every((s) => s.trim() !== "") ? undefined : "must be a non-empty array of non-empty strings");
const pattern: Check = (v) => (typeof v === "string" && v.includes("{name}") && v.includes("{state}") ? undefined : "must be a string containing {name} and {state}");

const breakpointName = (e: unknown): string | undefined => (typeof e === "string" ? e : isObject(e) && typeof e.name === "string" ? e.name : undefined);
const breakpoints: Check = (v) => {
  const form = 'must be a non-empty array of names or { "name": string, "width": positive number } objects';
  if (!Array.isArray(v) || v.length === 0) return form;
  const seen = new Set<string>();
  for (const e of v) {
    const name = breakpointName(e);
    if (name === undefined || name.trim() === "") return form;
    if (isObject(e) && (Object.keys(e).some((k) => k !== "name" && k !== "width") || (e.width !== undefined && !(isNumber(e.width, 0) && e.width > 0)))) {
      return `has an invalid entry "${name}": expected { "name": string, "width": positive number }`;
    }
    const key = name.trim().toLowerCase();
    if (seen.has(key)) return `has a duplicate name "${name}"`;
    seen.add(key);
  }
  return undefined;
};
const breakpointPattern: Check = (v) =>
  typeof v === "string" && v.includes("{name}") && v.includes("{breakpoint}") ? undefined : "must be a string containing {name} and {breakpoint}";

/** Validators for the option keys each rule knows; other keys are kept untouched. */
const OPTION_CHECKS: Partial<Record<RuleId, Record<string, Check>>> = {
  "A11Y-001": { minRatio: number(1), minRatioLarge: number(1) },
  "CMP-001": { minNodes: integer(1) },
  "DIF-001": { warnAt: number(0), blockAt: number(0), scope: stringList },
  "RSP-001": { breakpoints, screens: stringList, pattern: breakpointPattern, baseBreakpoint: (v) => (typeof v === "string" ? undefined : "must be a string") },
  "STA-001": { states, screens: stringList, pattern },
  "TOK-001": { properties, ignoreValues, onlyIn: stringList },
  "TOK-002": { scales, tolerance: number(0) },
};

function resolveRule(id: RuleId, raw: unknown): RuleConfig | string {
  if (!isObject(raw)) return `rules.${id} must be an object`;
  const out: Record<string, unknown> = { ...structuredClone(DEFAULT_CONFIG.rules[id]) };
  for (const [key, value] of Object.entries(raw)) {
    if (key === "enabled") return `rules.${id}.enabled is not a config key`;
    const check = key === "severity" ? (v: unknown) => (typeof v === "string" && SEVERITIES.includes(v) ? undefined : `must be one of ${SEVERITIES.join(", ")}`) : OPTION_CHECKS[id]?.[key];
    const problem = check?.(value);
    if (problem) return `rules.${id}.${key} ${problem}`;
    Object.defineProperty(out, key, { value: structuredClone(value), enumerable: true, writable: true, configurable: true });
  }
  if (OPT_IN_RULES.includes(id)) out.enabled = true;
  if (id === "RSP-001") {
    if (raw.breakpoints === undefined) return "rules.RSP-001.breakpoints is required";
    const base = out.baseBreakpoint;
    if (base !== undefined && !(out.breakpoints as BreakpointEntry[]).some((e) => breakpointName(e)?.trim().toLowerCase() === (base as string).trim().toLowerCase())) {
      return "rules.RSP-001.baseBreakpoint must be one of the breakpoint names";
    }
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
