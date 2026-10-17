import type { CompiledDocument } from "../compile/types.js";
import { OPT_IN_RULES, type GatesConfig, type RuleId } from "../gates/config.js";
import { runA11y001 } from "./A11Y-001.js";
import { cmp001 } from "./CMP-001.js";
import { dif001 } from "./DIF-001.js";
import { downgradeFigBlocks } from "./fig-review.js";
import { rsp001 } from "./RSP-001.js";
import { sch001 } from "./SCH-001.js";
import { sch002 } from "./SCH-002.js";
import { sch003 } from "./SCH-003.js";
import { sta001 } from "./STA-001.js";
import { run as tok001 } from "./TOK-001.js";
import { run as tok002 } from "./TOK-002.js";
import type { DiffContext, Rule, Severity, Violation } from "../gates/types.js";

export interface RuleEntry {
  id: RuleId;
  title: string;
  description: string;
  defaultSeverity: Severity;
  run: Rule;
}

/** One entry per rule; each rule card adds its own line here. */
const ENTRIES: RuleEntry[] = [
  {
    id: "A11Y-001",
    title: "Text contrast",
    description: "Text color against its effective background meets WCAG contrast in every theme combination.",
    defaultSeverity: "block",
    run: runA11y001,
  },
  {
    id: "CMP-001",
    title: "Detached instance",
    description: "A subtree that exactly repeats a reusable component's structure instead of being an instance of it.",
    defaultSeverity: "warn",
    run: cmp001,
  },
  {
    id: "DIF-001",
    title: "Blast radius",
    description: "A changed component or variable and the instances, nodes and screens it affects.",
    defaultSeverity: "warn",
    run: dif001,
  },
  {
    id: "RSP-001",
    title: "Responsive frames present",
    description: "A screen has a frame for each configured breakpoint, at the configured width (opt-in).",
    defaultSeverity: "warn",
    run: rsp001,
  },
  {
    id: "SCH-001",
    title: "Invalid document",
    description: "Duplicate node id, id containing `/`, unknown node type or unknown document version.",
    defaultSeverity: "block",
    run: sch001,
  },
  {
    id: "SCH-002",
    title: "Broken reference",
    description: "Instance of a missing or non-reusable node, missing descendants path or reference cycle.",
    defaultSeverity: "block",
    run: sch002,
  },
  {
    id: "SCH-003",
    title: "Broken variable",
    description: "Undefined variable, variable alias cycle or escaped variable string.",
    defaultSeverity: "block",
    run: sch003,
  },
  {
    id: "STA-001",
    title: "All states covered",
    description: "A screen or component that declares data has an empty, error and loading state variant (opt-in).",
    defaultSeverity: "warn",
    run: sta001,
  },
  {
    id: "TOK-001",
    title: "Hard-coded value",
    description: "A literal colour, radius, spacing, font or stroke width where a design variable should be used.",
    defaultSeverity: "warn",
    run: tok001,
  },
  {
    id: "TOK-002",
    title: "Off-scale value",
    description: "A numeric value, or numeric variable, that is not on the configured spacing, radius, font size or stroke width scale.",
    defaultSeverity: "warn",
    run: tok002,
  },
];

/** All registered rules, sorted by id. */
export const registry: readonly RuleEntry[] = [...ENTRIES].sort((a, b) => cmp(a.id, b.id));

export { OPT_IN_RULES };

export interface RuleInput {
  /** Repo-relative POSIX path. */
  file: string;
  compiled: CompiledDocument;
  /** Diff context for this file only. */
  diff?: DiffContext;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Only block and warn are adjustable; review and info, and violations that fix their severity, are left alone. */
function adjust(v: Violation, override: Severity | "off" | undefined): Violation {
  if (!override || override === "off" || v.fixedSeverity || (v.severity !== "block" && v.severity !== "warn")) return v;
  return { ...v, severity: override };
}

/** Run every enabled rule on every file; output sorted by file, nodeId, rule, prop, message. */
export function runRules(files: readonly RuleInput[], config: GatesConfig, entries: readonly RuleEntry[] = registry): Violation[] {
  const out: Violation[] = [];
  for (const input of files) {
    for (const entry of entries) {
      if (OPT_IN_RULES.includes(entry.id) && config.rules[entry.id]?.enabled !== true) continue;
      const override = config.rules[entry.id]?.severity;
      if (override === "off") continue;
      const adjusted = entry.run(input.compiled, config, input.diff).map((v) => adjust({ ...v, file: input.file }, override));
      out.push(...downgradeFigBlocks(adjusted, input.compiled));
    }
  }
  return out.sort(
    (a, b) => cmp(a.file, b.file) || cmp(a.nodeId, b.nodeId) || cmp(a.rule, b.rule) || cmp(a.prop ?? "", b.prop ?? "") || cmp(a.message, b.message),
  );
}
