import { test } from "node:test";
import assert from "node:assert/strict";
import { lay004 } from "../src/rules/LAY-004.js";
import { compile, resolveConfig, runRules, type GatesConfig, type Violation } from "../src/index.js";
import { compileFixture } from "./helpers/gates.js";

const ON = { rules: { "LAY-004": {} } };
const config = (raw?: unknown): GatesConfig => {
  const r = resolveConfig(raw);
  assert.ok("config" in r, JSON.stringify(r));
  return r.config;
};

async function lay4(name: string, raw: unknown = ON): Promise<Violation[]> {
  const file = `LAY-004/${name}.pen`;
  const compiled = await compileFixture(file);
  return runRules([{ file, compiled }], config(raw)).filter((v) => v.rule === "LAY-004");
}
const summary = (vs: Violation[]): string[] => vs.map((v) => `${v.nodeId}.${v.prop}:${v.severity}`);

test("20px blocks, 32px warns, 44px passes", async () => {
  const out = await lay4("sizes.fail");
  assert.deepEqual(summary(out), ["edge.width:warn", "medium.width:warn", "small.height:block"]);
  assert.equal(out[1]?.message, "touch target width 32 is below the recommended 44");
  assert.equal(out[2]?.message, "touch target height 20 is below the minimum 24");
});

test("exactly min and exactly recommended are fine", async () => {
  assert.deepEqual(await lay4("at-recommended.pass"), []);
});

test("a variable-bound size is resolved in the node's own theme", async () => {
  const out = await lay4("variable-theme.fail");
  assert.deepEqual(summary(out), ["dark.width:block"]);
  assert.equal(out[0]?.message, "touch target width 20 ($hit) is below the minimum 24");
  assert.equal(out[0]?.theme, "mode=dark");
});

test("fill, hug, unresolved and missing sizes are review with fixed severity", async () => {
  const out = await lay4("not-fixed.fail");
  assert.deepEqual(summary(out), ["bad.width:review", "fluid.height:review", "fluid.width:review", "missing.height:review"]);
  for (const v of out) {
    assert.equal(v.fixedSeverity, true);
    assert.equal(v.message, "size is not fixed; touch target cannot be checked statically");
  }
  const forced = await lay4("not-fixed.fail", { rules: { "LAY-004": { severity: "block" } } });
  assert.ok(forced.every((v) => v.severity === "review"));
});

test("a small node that is not interactive is ignored", async () => {
  assert.deepEqual(await lay4("non-interactive.pass"), []);
});

test("interactive.components matches an instance's component and a reusable definition", async () => {
  const raw = { rules: { "LAY-004": { interactive: { components: ["Chip"] } } } };
  // Definition (matched only by the glob) is checked once; i1 inherits both sizes; i2 overrides width.
  assert.deepEqual(summary(await lay4("component-glob.fail", raw)), ["chip.height:block", "chip.width:block", "i2.width:warn"]);
  // Without the glob nothing here is interactive by name.
  assert.deepEqual(await lay4("component-glob.fail"), []);
});

test("a glob can match the component id", async () => {
  const raw = { rules: { "LAY-004": { interactive: { components: ["ch*"] } } } };
  assert.deepEqual(summary(await lay4("component-glob.fail", raw)), ["chip.height:block", "chip.width:block", "i2.width:warn"]);
});

test("interactive.namePattern matches plain nodes case-insensitively", async () => {
  assert.deepEqual(summary(await lay4("name-regex.fail")), ["save.height:warn", "save.width:warn"]);
});

test("a custom namePattern replaces the default but keeps components", async () => {
  const raw = { rules: { "LAY-004": { interactive: { namePattern: "^Buttons$" } } } };
  assert.deepEqual(config(raw).rules["LAY-004"].interactive.components, []);
  assert.deepEqual(summary(await lay4("name-regex.fail", raw)), ["buttons.height:block", "buttons.width:block"]);
});

test("an inherited undersized size is reported once on the definition, an override on the instance", async () => {
  assert.deepEqual(summary(await lay4("inherited.fail")), ["btn.height:block", "btn.width:block", "i2.width:block"]);
});

test("a size missing on both component and instance is reported once on the definition", async () => {
  assert.deepEqual(summary(await lay4("hug-component.fail")), ["btn.height:warn", "btn.width:review"]);
});

test("an instance renamed away from the component is still interactive by the component's name", async () => {
  assert.deepEqual(summary(await lay4("component-name.fail")), ["btn.height:block", "btn.width:block", "i1.width:block"]);
});

test("only the node itself is checked, not its descendants", async () => {
  const out = await lay4("inherited.fail");
  assert.ok(!out.some((v) => v.nodeId.includes("label")));
});

test("custom min and recommended", async () => {
  const raw = { rules: { "LAY-004": { min: 10, recommended: 30 } } };
  assert.deepEqual(summary(await lay4("sizes.fail", raw)), ["edge.width:warn", "small.height:warn"]);
  const high = { rules: { "LAY-004": { min: 50, recommended: 60 } } };
  assert.ok((await lay4("sizes.fail", high)).every((v) => v.severity === "block"));
});

test("config validation", () => {
  const err = (raw: unknown): string => {
    const r = resolveConfig(raw);
    assert.ok("error" in r, "expected an error");
    return r.error;
  };
  assert.match(err({ rules: { "LAY-004": { min: 30, recommended: 20 } } }), /recommended must not be below min/);
  assert.match(err({ rules: { "LAY-004": { min: 48 } } }), /recommended must not be below min/);
  assert.match(err({ rules: { "LAY-004": { min: 0 } } }), /min must be a number > 0/);
  assert.match(err({ rules: { "LAY-004": { recommended: -1 } } }), /recommended must be a number > 0/);
  assert.match(err({ rules: { "LAY-004": { interactive: { namePattern: "(" } } } }), /interactive/);
  assert.match(err({ rules: { "LAY-004": { interactive: { namePattern: "(a+)+" } } } }), /nested quantifiers/);
  assert.match(err({ rules: { "LAY-004": { interactive: { components: "x" } } } }), /interactive/);
  assert.match(err({ rules: { "LAY-004": { interactive: { other: [] } } } }), /interactive/);
});

test("interactive is merged key by key over the default", () => {
  const c = config({ rules: { "LAY-004": { interactive: { components: ["Chip"] } } } }).rules["LAY-004"];
  assert.deepEqual(c.interactive.components, ["Chip"]);
  assert.match(c.interactive.namePattern, /button/);
  const d = config(ON).rules["LAY-004"];
  assert.deepEqual([d.min, d.recommended, d.interactive.components], [24, 44, []]);
});

test("silent when not enabled", async () => {
  assert.deepEqual(await lay4("sizes.fail", null), []);
  assert.deepEqual(await lay4("sizes.fail", { rules: {} }), []);
  assert.deepEqual(await lay4("sizes.fail", { rules: { "LAY-004": { severity: "off" } } }), []);
});

test("output is sorted by node then prop and (nodeId, prop) is unique", async () => {
  const direct = lay004(await compileFixture("LAY-004/sizes.fail.pen"), config(ON)).map((v) => v.nodeId);
  assert.deepEqual(direct, ["edge", "medium", "small"]);
  for (const name of ["sizes.fail", "not-fixed.fail", "inherited.fail", "name-regex.fail"]) {
    const out = await lay4(name);
    const keys = out.map((v) => `${v.nodeId}\u0000${v.prop}`);
    assert.deepEqual(keys, [...keys].sort(), name);
    assert.equal(new Set(keys).size, keys.length, name);
  }
});

test("names longer than 200 characters are only matched on their first 200", () => {
  const long = (name: string) => compile({ version: "2.6", children: [{ id: "f", type: "frame", name, width: 10, height: 10 }] } as never, { file: "long.pen" });
  const run = (name: string) => lay004(long(name), config(ON));
  assert.deepEqual(run(`${"x".repeat(250)} button`), []);
  assert.equal(run(`button ${"x".repeat(250)}`).length, 2);
});
