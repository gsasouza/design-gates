import type { Violation } from "../gates/types.js";

/** File-level SCH-001 violation for a `.pen` file that cannot be read or that `parsePen` rejects. */
export function parseFailureViolation(file: string, error: unknown): Violation {
  const message = error instanceof Error ? error.message : String(error);
  return { rule: "SCH-001", severity: "block", file, nodeId: "", path: "", message };
}
