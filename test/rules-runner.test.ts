import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, DEFAULT_CONFIG, registry, resolveConfig, runRules, type RuleEntry, type Severity, type Violation } from "../src/index.js";

const compiled = compile({ version: "2.6", children: [] });

const v = (over: Partial<Violation>): Violation => ({ rule: "SCH-001", severity: "block", file: "", nodeId: "n", path: "n", message: "m", ...over });
const entry = (id: RuleEntry["id"], violations: Violation[], defaultSeverity: Severity = "block"): RuleEntry => ({
  id,
  title: id,
  description: id,
  defaultSeverity,
  run: () => violations,
});

test("the registry holds the registered rules sorted by id", () => {
  assert.deepEqual(registry.map((r) => r.id), ["A11Y-001", "A11Y-003", "CMP-001", "CMP-002", "CMP-005", "CNT-001", "CNT-002", "CNT-003", "DIF-001", "RSP-001", "SCH-001", "SCH-002", "SCH-003", "STA-001", "TOK-001", "TOK-002", "TOK-003", "TOK-005"]);
  assert.deepEqual(runRules([{ file: "a.pen", compiled }], DEFAULT_CONFIG), []);
});

test("output is sorted by file, nodeId, rule, prop, message and stamped with the file", () => {
  const entries = [
    entry("SCH-002", [v({ rule: "SCH-002", nodeId: "b" }), v({ rule: "SCH-002", nodeId: "a", prop: "z", message: "x" })]),
    entry("SCH-001", [v({ nodeId: "a", prop: "y" }), v({ nodeId: "a", prop: "z", message: "a" })]),
  ];
  const out = runRules([{ file: "b.pen", compiled }, { file: "a.pen", compiled }], DEFAULT_CONFIG, entries);
  assert.deepEqual(
    out.map((x) => `${x.file}:${x.nodeId}:${x.rule}:${x.prop ?? ""}:${x.message}`),
    [
      "a.pen:a:SCH-001:y:m",
      "a.pen:a:SCH-001:z:a",
      "a.pen:a:SCH-002:z:x",
      "a.pen:b:SCH-002::m",
      "b.pen:a:SCH-001:y:m",
      "b.pen:a:SCH-001:z:a",
      "b.pen:a:SCH-002:z:x",
      "b.pen:b:SCH-002::m",
    ],
  );
});

test("rules set to off are skipped", () => {
  const config = resolveConfig({ rules: { "SCH-001": { severity: "off" } } });
  assert.ok("config" in config);
  const out = runRules([{ file: "a.pen", compiled }], config.config, [entry("SCH-001", [v({})]), entry("SCH-002", [v({ rule: "SCH-002" })])]);
  assert.deepEqual(out.map((x) => x.rule), ["SCH-002"]);
});

test("severity overrides only touch block and warn violations without fixedSeverity", () => {
  const config = resolveConfig({ rules: { "SCH-001": { severity: "warn" } } });
  assert.ok("config" in config);
  const out = runRules([{ file: "a.pen", compiled }], config.config, [
    entry("SCH-001", [
      v({ nodeId: "1", severity: "block" }),
      v({ nodeId: "2", severity: "warn" }),
      v({ nodeId: "3", severity: "review" }),
      v({ nodeId: "4", severity: "info" }),
      v({ nodeId: "5", severity: "warn", fixedSeverity: true }),
      v({ nodeId: "6", severity: "block", fixedSeverity: true }),
    ]),
  ]);
  assert.deepEqual(out.map((x) => x.severity), ["warn", "warn", "review", "info", "warn", "block"]);
  const up = resolveConfig({ rules: { "SCH-001": { severity: "block" } } });
  assert.ok("config" in up);
  const escalated = runRules([{ file: "a.pen", compiled }], up.config, [entry("SCH-001", [v({ nodeId: "1", severity: "warn" }), v({ nodeId: "2", severity: "review" })])]);
  assert.deepEqual(escalated.map((x) => x.severity), ["block", "review"]);
});
