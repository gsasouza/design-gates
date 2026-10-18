import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, runRules, type GatesConfig, type Violation } from "../src/index.js";
import { compileFixture } from "./helpers/gates.js";

const ON = { rules: { "A11Y-003": {} } };
const config = (raw?: unknown): GatesConfig => {
  const r = resolveConfig(raw);
  assert.ok("config" in r, JSON.stringify(r));
  return r.config;
};

async function a11y3(name: string, raw: unknown = ON): Promise<Violation[]> {
  const file = `A11Y-003/${name}.pen`;
  const compiled = await compileFixture(file);
  return runRules([{ file, compiled }], config(raw)).filter((v) => v.rule === "A11Y-003");
}
const summary = (vs: Violation[]): string[] => vs.map((v) => `${v.nodeId}:${v.severity}:${v.theme}`);

test("literal 11 warns, 9 blocks, 12 and 13 pass", async () => {
  assert.deepEqual(summary(await a11y3("literals.fail")), ["a:warn:default", "b:block:default"]);
});

test("exactly min is fine", async () => {
  assert.deepEqual(await a11y3("at-min.pass"), []);
});

test("custom min and hardMin are respected", async () => {
  const raw = { rules: { "A11Y-003": { min: 13, hardMin: 11 } } };
  assert.deepEqual(summary(await a11y3("literals.fail", raw)), ["a:warn:default", "b:block:default", "c:warn:default"]);
  assert.deepEqual(summary(await a11y3("literals.fail", { rules: { "A11Y-003": { min: 9, hardMin: 5 } } })), []);
});

test("message names value, threshold and variable", async () => {
  const [a, b] = await a11y3("literals.fail");
  assert.equal(a?.message, "fontSize 11 is below the min 12");
  assert.equal(b?.message, "fontSize 9 is below the hardMin 10");
  const v = await a11y3("variable-theme.fail");
  assert.equal(v[0]?.message, "fontSize 9 ($caption) is below the hardMin 10");
  assert.equal(v[0]?.prop, "fontSize");
});

test("a variable is resolved in the node's own theme", async () => {
  const out = await a11y3("variable-theme.fail");
  assert.deepEqual(summary(out), ["dark:block:mode=dark"]);
});

test("an inherited literal is reported once on the component", async () => {
  const out = await a11y3("component-literal.fail");
  assert.deepEqual(summary(out), ["label:warn:default"]);
  assert.deepEqual(out[0]?.affectedInstances, ["i1", "i2"]);
});

test("an inherited variable failing in one instance blocks on the definition", async () => {
  const out = await a11y3("component-variable.fail");
  assert.deepEqual(summary(out), ["label:block:mode=dark"]);
  assert.deepEqual(out[0]?.affectedInstances, ["iDark"]);
});

test("an instance override is reported on the instance, not the component", async () => {
  const out = await a11y3("override.fail");
  assert.deepEqual(summary(out), ["i1:block:default"]);
  assert.equal(out[0]?.affectedInstances, undefined);
});

test("the rule does nothing unless configured", async () => {
  for (const name of ["literals.fail", "component-literal.fail", "override.fail"]) {
    assert.deepEqual(await a11y3(name, null), [], name);
    assert.deepEqual(await a11y3(name, { rules: {} }), [], name);
  }
});

test("findings are sorted by nodeId and fingerprints are unique", async () => {
  const out = await a11y3("literals.fail", { rules: { "A11Y-003": { min: 14 } } });
  assert.equal(out.length, 4);
  const ids = out.map((v) => v.nodeId);
  assert.deepEqual(ids, [...ids].sort());
  const keys = out.map((v) => `${v.rule}\u0000${v.nodeId}\u0000${v.prop}`);
  assert.equal(new Set(keys).size, keys.length);
});

test("invalid options are config errors", () => {
  for (const bad of [{ min: 0 }, { min: -1 }, { hardMin: 0 }, { min: "12" }, { hardMin: Infinity }, { hardMin: 13 }, { min: 8 }]) {
    const r = resolveConfig({ rules: { "A11Y-003": bad } });
    assert.ok("error" in r, JSON.stringify(bad));
  }
  assert.ok("config" in resolveConfig({ rules: { "A11Y-003": { min: 10, hardMin: 10 } } }));
});

test("the worst copy decides severity and theme on the definition", async () => {
  const out = await a11y3("worst-case.fail");
  assert.deepEqual(summary(out), ["label:block:mode=dark"]);
  assert.equal(out[0]?.message, "fontSize 9 ($body) is below the hardMin 10");
  assert.deepEqual(out[0]?.affectedInstances, ["iDark", "iLight"]);
});

test("a failing copy outside any listed instance counts but is not an affected instance", async () => {
  const out = await a11y3("nested-copy.fail");
  assert.deepEqual(summary(out), ["inner:warn:default"]);
  assert.equal(out[0]?.affectedInstances, undefined);
});

test("an unlisted failing copy alone decides severity and theme on the definition", async () => {
  const out = await a11y3("unlisted-copy.fail");
  assert.deepEqual(summary(out), ["label:block:mode=dark"]);
  assert.equal(out[0]?.message, "fontSize 9 ($cap) is below the hardMin 10");
  assert.equal(out[0]?.affectedInstances, undefined);
});
