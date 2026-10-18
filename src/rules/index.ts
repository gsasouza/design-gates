import type { CompiledDocument } from "../compile/types.js";
import { OPT_IN_RULES, type GatesConfig, type RuleId } from "../gates/config.js";
import { runA11y001 } from "./A11Y-001.js";
import { a11y003 } from "./A11Y-003.js";
import { runA11y004 } from "./A11Y-004.js";
import { cmp001 } from "./CMP-001.js";
import { cmp002 } from "./CMP-002.js";
import { cmp005 } from "./CMP-005.js";
import { cnt001 } from "./CNT-001.js";
import { cnt002 } from "./CNT-002.js";
import { cnt003 } from "./CNT-003.js";
import { dif001 } from "./DIF-001.js";
import { dif002 } from "./DIF-002.js";
import { downgradeFigBlocks } from "./fig-review.js";
import { lay004 } from "./LAY-004.js";
import { rsp001 } from "./RSP-001.js";
import { sch001 } from "./SCH-001.js";
import { sch002 } from "./SCH-002.js";
import { sch003 } from "./SCH-003.js";
import { sta001 } from "./STA-001.js";
import { run as tok001 } from "./TOK-001.js";
import { run as tok002 } from "./TOK-002.js";
import { run as tok003 } from "./TOK-003.js";
import { run as tok005 } from "./TOK-005.js";
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
    id: "A11Y-003",
    title: "Minimum font size",
    description: "A font size below the configured minimum warns, below the hard minimum blocks (opt-in).",
    defaultSeverity: "warn",
    run: a11y003,
  },
  {
    id: "A11Y-004",
    title: "Text over image",
    description: "Text over an image, mesh gradient, shader or background blur has a scrim between it and the background (opt-in).",
    defaultSeverity: "warn",
    run: runA11y004,
  },
  {
    id: "CMP-001",
    title: "Detached instance",
    description: "A subtree that exactly repeats a reusable component's structure instead of being an instance of it.",
    defaultSeverity: "warn",
    run: cmp001,
  },
  {
    id: "CMP-002",
    title: "Improper override",
    description: "An instance override of a property outside the component's allowlist, or a node or children replacement outside a slot (opt-in).",
    defaultSeverity: "warn",
    run: cmp002,
  },
  {
    id: "CMP-005",
    title: "Redundant override",
    description: "An instance override whose value equals the component's own value at that path and key (opt-in; info).",
    defaultSeverity: "info",
    run: cmp005,
  },
  {
    id: "CNT-001",
    title: "Placeholder text",
    description: "A text node whose content matches a placeholder pattern such as lorem ipsum, TODO, Text or Label (opt-in).",
    defaultSeverity: "warn",
    run: cnt001,
  },
  {
    id: "CNT-002",
    title: "Empty text",
    description: "A text node whose content is missing, empty or only whitespace (opt-in).",
    defaultSeverity: "warn",
    run: cnt002,
  },
  {
    id: "CNT-003",
    title: "Default name",
    description: "A component or screen with no name or a default name such as Frame 12 (opt-in).",
    defaultSeverity: "warn",
    run: cnt003,
  },
  {
    id: "DIF-001",
    title: "Blast radius",
    description: "A changed component or variable and the instances, nodes and screens it affects.",
    defaultSeverity: "warn",
    run: dif001,
  },
  {
    id: "DIF-002",
    title: "Out of scope",
    description: "A frame changed since the base in a node outside the declared scope (opt-in, only with --base).",
    defaultSeverity: "warn",
    run: dif002,
  },
  {
    id: "LAY-004",
    title: "Touch target",
    description: "An interactive node (matched by component glob or name pattern) is at least the minimum size, and ideally the recommended size, in width and height (opt-in).",
    defaultSeverity: "warn",
    run: lay004,
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
  {
    id: "TOK-003",
    title: "Incomplete theme",
    description: "A themed variable has no value for a theme combination in use, or for a declared value of an axis it varies on (opt-in).",
    defaultSeverity: "block",
    run: tok003,
  },
  {
    id: "TOK-005",
    title: "Raw token value",
    description: "A literal equal to the value of an existing variable in the node's theme, written raw instead of bound to it (opt-in).",
    defaultSeverity: "warn",
    run: tok005,
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
