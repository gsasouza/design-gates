import type { Rule } from "../gates/types.js";
import { diagnosticViolations } from "./diagnostics.js";

// A .fig is judged on its normalized document; a violation on a fig-only construct is downgraded to review by runRules.
export const sch003: Rule = (compiled) => diagnosticViolations(compiled, "SCH-003");
