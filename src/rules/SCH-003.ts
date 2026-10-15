import type { Rule } from "../gates/types.js";
import { diagnosticViolations } from "./diagnostics.js";

export const sch003: Rule = (compiled) => diagnosticViolations(compiled, "SCH-003");
