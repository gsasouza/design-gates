import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAgent } from "../src/check/format.js";
import { resolveConfig, runRules, type GatesConfig, type Violation } from "../src/index.js";
import { compileFixture } from "./helpers/gates.js";

const config = (raw?: unknown): GatesConfig => {
  const r = resolveConfig(raw);
  assert.ok("config" in r, JSON.stringify(r));
  return r.config;
};
const configError = (raw: unknown): string => {
  const r = resolveConfig(raw);
  assert.ok("error" in r, "expected a config error");
  return r.error;
};

async function run(rule: string, fixture: string, raw?: unknown): Promise<Violation[]> {
  const file = `${rule}/${fixture}.pen`;
  const compiled = await compileFixture(file);
  return runRules([{ file, compiled }], config(raw ?? { rules: { [rule]: {} } })).filter((v) => v.rule === rule);
}
const summary = (vs: Violation[]): string[] => vs.map((v) => `${v.nodeId}:${v.prop}:${v.severity}`);

const C1 = "CNT-001";
const C2 = "CNT-002";
const C3 = "CNT-003";

test("CNT-001 reports placeholder text with the first matching pattern, case-insensitively", async () => {
  const out = await run(C1, "placeholders.fail");
  assert.deepEqual(summary(out), ["t-label:content:warn", "t-lorem:content:warn", "t-text:content:warn", "t-todo:content:warn"]);
  assert.equal(out.find((v) => v.nodeId === "t-lorem")?.message, 'Placeholder text "Lorem ipsum dolor" matches /lorem/');
  assert.equal(out.find((v) => v.nodeId === "t-todo")?.message, 'Placeholder text "todo: fix" matches /\\bTODO\\b/');
  assert.equal(out.find((v) => v.nodeId === "t-label")?.message, 'Placeholder text "LABEL" matches Label');
  assert.equal(out.every((v) => v.fix === undefined), true);
});

test("CNT-001 plain strings match the whole trimmed content, not a substring", async () => {
  const ids = (await run(C1, "placeholders.fail")).map((v) => v.nodeId);
  assert.equal(ids.includes("t-textual"), false);
  assert.equal(ids.includes("t-text"), true);
  assert.deepEqual(await run(C1, "clean.pass"), []);
});

test("CNT-001 custom patterns replace the defaults", async () => {
  const out = await run(C1, "placeholders.fail", { rules: { [C1]: { patterns: ["Welcome back", "/^textual$/"] } } });
  assert.deepEqual(out.map((v) => v.nodeId), ["t-real", "t-textual"]);
  assert.deepEqual(await run(C1, "placeholders.fail", { rules: { [C1]: { patterns: [] } } }), []);
});

test("CNT-001 patterns are validated like TOK-001 ignoreValues", () => {
  assert.match(configError({ rules: { [C1]: { patterns: ["/(/"] } } }), /^rules\.CNT-001\.patterns has an invalid regular expression \/\(\/$/);
  assert.match(configError({ rules: { [C1]: { patterns: ["/(a+)+/"] } } }), /nested quantifiers/);
  assert.match(configError({ rules: { [C1]: { patterns: [`/${"a".repeat(200)}/`] } } }), /longer than 200 characters/);
  assert.match(configError({ rules: { [C1]: { patterns: "x" } } }), /must be an array of strings/);
  assert.match(configError({ rules: { "TOK-001": { ignoreValues: { fill: ["/(a+)+/"] } } } }), /^rules\.TOK-001\.ignoreValues has a regular expression with nested quantifiers \/\(a\+\)\+\/$/);
});

test("CNT-002 reports missing, empty, blank and non-string content with a remove fix", async () => {
  const out = await run(C2, "empty.fail");
  assert.deepEqual(summary(out), ["t-blank:content:warn", "t-empty:content:warn", "t-missing:content:warn", "t-number:content:warn"]);
  assert.equal(out.every((v) => JSON.stringify(v.fix) === '{"type":"remove"}'), true);
  assert.deepEqual(await run(C2, "filled.pass"), []);
});

test("CNT-002 JSON output carries the remove fix", async () => {
  const out = await run(C2, "empty.fail");
  const text = formatAgent(out);
  const parsed = JSON.parse(text) as { violations: Array<{ nodeId: string; fix?: unknown }> };
  assert.deepEqual(parsed.violations.find((v) => v.nodeId === "t-empty")?.fix, { type: "remove" });
});

test("CNT-001 inherited placeholder: one finding on the component, an override on the overriding node", async () => {
  const out = await run(C1, "inherited.fail");
  assert.deepEqual(out.map((v) => [v.nodeId, v.path, v.affectedInstances]), [
    ["i3::title", "screen/i3/title", undefined],
    ["title", "comp/title", ["i1", "i2", "i3"]],
  ]);
  assert.equal(out[0]?.message, 'Placeholder text "TODO" matches /\\bTODO\\b/');
});

test("CNT-002 inherited empty text: one finding on the component, an override on the overriding node", async () => {
  const out = await run(C2, "inherited.fail");
  assert.deepEqual(out.map((v) => [v.nodeId, v.affectedInstances]), [["i3::title", undefined], ["title", ["i1", "i2", "i3"]]]);
});

test("CNT-002 content missing on a component text is reported once on the definition, never on the copies", async () => {
  const out = await run(C2, "missing-inherited.fail");
  assert.deepEqual(out.map((v) => [v.nodeId, v.affectedInstances]), [["title", ["i1", "i2"]]]);
});

test("CNT-003 reports unnamed and default-named components (warn) and screens (info) on the candidate", async () => {
  const out = await run(C3, "names.fail");
  assert.deepEqual(summary(out), ["c-bare:name:warn", "c-default:name:warn", "c-noname:name:warn", "s-default:name:info"]);
  assert.equal(out.find((v) => v.nodeId === "c-default")?.message, 'The component has the default name "Frame 12"');
  assert.equal(out.find((v) => v.nodeId === "c-noname")?.message, "The component name is missing");
  assert.equal(out.find((v) => v.nodeId === "s-default")?.path, "s-default");
  assert.equal(out.every((v) => v.fix === undefined), true);
});

test("CNT-003 ignores fuller names and nested non-reusable frames named like defaults", async () => {
  const ids = (await run(C3, "names.fail")).map((v) => v.nodeId);
  for (const id of ["c-good", "s-good", "nested"]) assert.equal(ids.includes(id), false, id);
});

test("CNT-003 custom pattern is respected and fully anchored, case-sensitively", async () => {
  const frame = await run(C3, "names.fail", { rules: { [C3]: { pattern: "Frame" } } });
  assert.deepEqual(frame.map((v) => v.nodeId), ["c-noname"]);
  const header = await run(C3, "names.fail", { rules: { [C3]: { pattern: "Frame header" } } });
  assert.deepEqual(header.map((v) => v.nodeId), ["c-good", "c-noname"]);
  const lower = await run(C3, "names.fail", { rules: { [C3]: { pattern: "group" } } });
  assert.deepEqual(lower.map((v) => v.nodeId), ["c-noname"]);
  const alt = await run(C3, "names.fail", { rules: { [C3]: { pattern: "Home|Group" } } });
  assert.deepEqual(alt.map((v) => v.nodeId), ["c-bare", "c-noname", "s-good"]);
});

test("CNT-003 pattern must compile, be short and have no nested quantifiers", () => {
  assert.match(configError({ rules: { [C3]: { pattern: "(" } } }), /^rules\.CNT-003\.pattern has an invalid regular expression \($/);
  assert.match(configError({ rules: { [C3]: { pattern: "(a+)+" } } }), /nested quantifiers/);
  assert.match(configError({ rules: { [C3]: { pattern: "a".repeat(201) } } }), /longer than 200 characters/);
  assert.match(configError({ rules: { [C3]: { pattern: 5 } } }), /must be a regular expression source string/);
  assert.ok("config" in resolveConfig({ rules: { [C3]: { pattern: "a".repeat(200) } } }));
});

test("the CNT rules are opt-in: a document that would fail gives no finding unless configured", async () => {
  const cases: Array<[string, string]> = [[C1, "placeholders.fail"], [C2, "empty.fail"], [C3, "names.fail"]];
  for (const [rule, fixture] of cases) {
    const file = `${rule}/${fixture}.pen`;
    const compiled = await compileFixture(file);
    assert.ok((await run(rule, fixture)).length > 0, `${rule} runs when configured`);
    for (const raw of [undefined, {}, { rules: { "SCH-001": {} } }, { rules: { [rule]: { severity: "off" } } }]) {
      assert.deepEqual(runRules([{ file, compiled }], config(raw)).filter((v) => v.rule === rule), [], `${rule} ${JSON.stringify(raw)}`);
    }
  }
});

test("findings are sorted by nodeId then prop and every baseline fingerprint is unique", async () => {
  const cases: Array<[string, string]> = [[C1, "placeholders.fail"], [C1, "inherited.fail"], [C2, "empty.fail"], [C2, "inherited.fail"], [C3, "names.fail"]];
  for (const [rule, fixture] of cases) {
    const out = await run(rule, fixture);
    assert.ok(out.length >= 2, `${rule} ${fixture}`);
    const keys = out.map((v) => `${v.nodeId}\u0000${v.prop}`);
    assert.deepEqual(keys, [...keys].sort(), `${rule} ${fixture} sorted`);
    const prints = out.map((v) => `${v.rule}\u0000${v.nodeId}\u0000${v.prop}`);
    assert.equal(new Set(prints).size, prints.length, `${rule} ${fixture} unique`);
  }
});

test("all three rules together on one document keep fingerprints unique", async () => {
  const file = `${C1}/placeholders.fail.pen`;
  const compiled = await compileFixture(file);
  const out = runRules([{ file, compiled }], config({ rules: { [C1]: {}, [C2]: {}, [C3]: {} } }));
  const prints = out.map((v) => `${v.rule}\u0000${v.nodeId}\u0000${v.prop}`);
  assert.equal(new Set(prints).size, prints.length);
  assert.deepEqual([...new Set(out.map((v) => v.rule))], [C1, C2]);
});
