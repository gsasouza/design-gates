import type { Severity, Violation } from "../gates/types.js";
import type { RuleEntry } from "../rules/index.js";

export type Format = "agent" | "sarif" | "text";
export const FORMATS: readonly Format[] = ["agent", "sarif", "text"];

export type Reported = Violation & { baselined?: true };

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function sortReported(list: Reported[]): Reported[] {
  return [...list].sort(
    (a, b) =>
      cmp(a.file, b.file) || cmp(a.nodeId, b.nodeId) || cmp(a.rule, b.rule) ||
      cmp(a.prop ?? "", b.prop ?? "") || cmp(a.theme ?? "", b.theme ?? "") || cmp(a.message, b.message),
  );
}

/** Agent output: fixed key order, optional keys only when present. */
export function formatAgent(list: Reported[]): string {
  const violations = sortReported(list).map((v) => ({
    rule: v.rule,
    severity: v.severity,
    file: v.file,
    nodeId: v.nodeId,
    path: v.path,
    message: v.message,
    ...(v.fix !== undefined && { fix: v.fix }),
    ...(v.affectedInstances !== undefined && { affectedInstances: v.affectedInstances }),
    ...(v.theme !== undefined && { theme: v.theme }),
    ...(v.baselined && { baselined: true }),
  }));
  return `${JSON.stringify({ violations })}\n`;
}

const LEVEL: Record<Severity, "error" | "warning" | "note"> = { block: "error", warn: "warning", review: "note", info: "note" };

export function formatSarif(list: Reported[], entries: readonly RuleEntry[]): string {
  const rules = [...entries].sort((a, b) => cmp(a.id, b.id));
  const results = sortReported(list).map((v) => {
    const index = rules.findIndex((r) => r.id === v.rule);
    const properties = {
      ...(v.prop !== undefined && { prop: v.prop }),
      ...(v.fix !== undefined && { fix: v.fix }),
      ...(v.affectedInstances !== undefined && { affectedInstances: v.affectedInstances }),
      ...(v.theme !== undefined && { theme: v.theme }),
    };
    return {
      ruleId: v.rule,
      ...(index >= 0 && { ruleIndex: index }),
      level: LEVEL[v.severity],
      message: { text: v.message },
      locations: [
        {
          physicalLocation: { artifactLocation: { uri: v.file } },
          logicalLocations: [{ name: v.nodeId, fullyQualifiedName: v.path, kind: "element" }],
        },
      ],
      ...(v.baselined && { baselineState: "unchanged" }),
      ...(Object.keys(properties).length > 0 && { properties }),
    };
  });
  const sarif = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "design-gates",
            rules: rules.map((r) => ({
              id: r.id,
              name: r.title,
              shortDescription: { text: r.title },
              fullDescription: { text: r.description },
              defaultConfiguration: { level: LEVEL[r.defaultSeverity] },
            })),
          },
        },
        results,
      },
    ],
  };
  return `${JSON.stringify(sarif, null, 2)}\n`;
}

export function formatText(list: Reported[]): string {
  const sorted = sortReported(list);
  const lines = sorted.map((v) => {
    const where = v.nodeId === "" ? v.file : `${v.file}#${v.path}${v.prop ? `.${v.prop}` : ""}`;
    return `${where}: ${v.severity} ${v.rule} ${v.message}${v.theme ? ` [theme ${v.theme}]` : ""}${v.baselined ? " (baselined)" : ""}`;
  });
  const count = (s: Severity): number => sorted.filter((v) => v.severity === s).length;
  const baselined = sorted.filter((v) => v.baselined).length;
  lines.push(
    sorted.length === 0
      ? "No violations."
      : `${sorted.length} violation(s): ${count("block")} block, ${count("warn")} warn, ${count("review")} review, ${count("info")} info (${baselined} baselined)`,
  );
  return `${lines.join("\n")}\n`;
}
