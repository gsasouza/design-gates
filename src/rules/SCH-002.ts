import type { Rule } from "../gates/types.js";
import { diagnosticViolations } from "./diagnostics.js";

export const sch002: Rule = (compiled) => diagnosticViolations(compiled, "SCH-002");
