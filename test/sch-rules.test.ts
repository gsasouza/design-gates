import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, parsePen, compile, parseFailureViolation, registry, runRules, type Violation } from "../src/index.js";
import { compileFixture } from "./helpers/gates.js";

type Expected = Pick<Violation, "rule" | "severity" | "nodeId" | "path"> & Pick<Violation, "message"> & Partial<Pick<Violation, "prop" | "fix" | "fixedSeverity">>;

const CASES: Record<string, { name: string; fail: Expected[] }[]> = {
  "SCH-001": [
    { name: "duplicate-id", fail: [{ rule: "SCH-001", severity: "block", nodeId: "dup~2", path: "f/dup~2", message: 'Duplicate node id "dup"' }] },
    { name: "id-slash", fail: [{ rule: "SCH-001", severity: "block", nodeId: "a%2Fb", path: "f/a%2Fb", message: 'Node id "a/b" contains "/"' }] },
    { name: "unknown-type", fail: [{ rule: "SCH-001", severity: "block", nodeId: "a", path: "f/a", message: 'Unknown node type "hexagon"' }] },
    {
      name: "unknown-version",
      fail: [{ rule: "SCH-001", severity: "warn", nodeId: "", path: "", fixedSeverity: true, message: 'Unknown document version "9.9"; the check ran in degraded mode' }],
    },
  ],
  "SCH-002": [
    { name: "missing-ref", fail: [{ rule: "SCH-002", severity: "block", nodeId: "use", path: "f/use", message: 'Instance refers to missing node "ghost"' }] },
    { name: "non-reusable-ref", fail: [{ rule: "SCH-002", severity: "block", nodeId: "use", path: "f/use", message: 'Instance refers to "plain", which is not reusable' }] },
    {
      name: "missing-descendant",
      fail: [{ rule: "SCH-002", severity: "block", nodeId: "use", path: "f/use", prop: "nope/label", message: 'Override path "nope/label" not found in "btn"' }],
    },
    {
      name: "ref-cycle",
      fail: [
        { rule: "SCH-002", severity: "block", nodeId: "a-b", path: "f/A/a-b", message: "Instance reference cycle: B -> A -> B" },
        { rule: "SCH-002", severity: "block", nodeId: "b-a", path: "f/B/b-a", message: "Instance reference cycle: A -> B -> A" },
      ],
    },
  ],
  "SCH-003": [
    { name: "undefined-variable", fail: [{ rule: "SCH-003", severity: "block", nodeId: "a", path: "f/a", prop: "fill", message: "Variable $nope is not defined" }] },
    {
      name: "escaped-variable",
      fail: [
        {
          rule: "SCH-003",
          severity: "block",
          nodeId: "a",
          path: "f/a",
          prop: "fill",
          message: 'Escaped variable string "\\$brand"',
          fix: { type: "replace", prop: "fill", value: "$brand" },
        },
      ],
    },
    {
      name: "alias-cycle",
      fail: [{ rule: "SCH-003", severity: "block", nodeId: "a", path: "f/a", prop: "fill", message: "Variable alias cycle: $loop-a -> $loop-b -> $loop-a" }],
    },
  ],
};

async function run(rule: string, file: string): Promise<Violation[]> {
  const entry = registry.find((r) => r.id === rule);
  assert.ok(entry);
  return entry.run(await compileFixture(file), DEFAULT_CONFIG);
}

for (const [rule, cases] of Object.entries(CASES)) {
  for (const { name, fail } of cases) {
    test(`${rule} ${name}: passing fixture is clean`, async () => {
      assert.deepEqual(await run(rule, `${rule}/${name}.pass.pen`), []);
    });
    test(`${rule} ${name}: failing fixture reports exact violations`, async () => {
      const out = await run(rule, `${rule}/${name}.fail.pen`);
      assert.deepEqual(out, fail.map((e) => ({ ...e, file: `${rule}/${name}.fail.pen` })));
    });
  }
  test(`${rule}: two runs are byte-identical`, async () => {
    const once = async () => JSON.stringify(await Promise.all(cases.map((c) => run(rule, `${rule}/${c.name}.fail.pen`))));
    assert.equal(await once(), await once());
  });
}

test("an unknown version is warn and keeps its severity under an override", async () => {
  const compiled = await compileFixture("SCH-001/unknown-version.fail.pen");
  const out = runRules([{ file: "a.pen", compiled }], { ...DEFAULT_CONFIG, rules: { ...DEFAULT_CONFIG.rules, "SCH-001": { severity: "block" } } });
  assert.deepEqual(out.map((v) => v.severity), ["warn"]);
});

test("a rejected or unparseable file becomes a file-level SCH-001 block", () => {
  for (const text of ["{ nope", "[]", '{ "version": "2.6" }']) {
    let error: unknown;
    try {
      compile(parsePen(text));
    } catch (e) {
      error = e;
    }
    const v = parseFailureViolation("x.pen", error);
    assert.equal(v.rule, "SCH-001");
    assert.equal(v.severity, "block");
    assert.equal(v.nodeId, "");
    assert.equal(v.path, "");
    assert.equal(v.file, "x.pen");
    assert.match(v.message, /^Invalid \.pen document/);
  }
});
