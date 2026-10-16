import type { CompileDiagnostic, CompiledDocument, DiagnosticRule } from "../compile/types.js";
import type { Fix, Violation } from "../gates/types.js";

const ESCAPED_MESSAGE = /^Escaped variable string "\\(\$.+)"$/;

function fixFor(d: CompileDiagnostic): Fix | undefined {
  if (d.code !== "escaped-variable" || d.prop === undefined) return undefined;
  const value = ESCAPED_MESSAGE.exec(d.message)?.[1];
  return value === undefined ? undefined : { type: "replace", prop: d.prop, value };
}

/** Turn the compiler diagnostics of one rule into violations; the compiler already sorts them. */
export function diagnosticViolations(compiled: CompiledDocument, rule: DiagnosticRule): Violation[] {
  return compiled.diagnostics
    .filter((d) => d.rule === rule)
    .map((d) => {
      const fix = fixFor(d);
      const unknownVersion = d.code === "unknown-version" || d.code === "unknown-fig-version";
      return {
        rule,
        severity: unknownVersion ? "warn" : "block",
        file: compiled.file,
        nodeId: d.nodeId,
        path: d.path,
        ...(d.prop !== undefined ? { prop: d.prop } : {}),
        message: unknownVersion ? `${d.message}; the check ran in degraded mode` : d.message,
        ...(fix ? { fix } : {}),
        ...(unknownVersion ? { fixedSeverity: true } : {}),
      };
    });
}
