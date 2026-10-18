import { test } from "node:test";
import assert from "node:assert/strict";
import { registry, resolveConfig, runRules, type GatesConfig, type Violation } from "../src/index.js";
import { compileFixture } from "./helpers/gates.js";

const ON = { rules: { "CMP-005": {} } };
const config = (raw?: unknown): GatesConfig => {
  const r = resolveConfig(raw);
  assert.ok("config" in r, JSON.stringify(r));
  return r.config;
};

const cmp5 = (name: string, raw: unknown = ON): Promise<Violation[]> => load(name, raw);

async function load(name: string, raw: unknown): Promise<Violation[]> {
  const file = `CMP-005/${name}.pen`;
  const compiled = await compileFixture(file);
  return runRules([{ file, compiled }], config(raw)).filter((v) => v.rule === "CMP-005");
}
const props = (vs: Violation[]): (string | undefined)[] => vs.map((v) => v.prop);

test("an identical literal override is redundant, with info severity and a message", async () => {
  const out = await cmp5("literal.fail");
  assert.deepEqual(props(out), ["descendants.label.content"]);
  assert.equal(out[0]?.severity, "info");
  assert.equal(out[0]?.nodeId, "a");
  assert.equal(out[0]?.message, 'override of "content" on descendants path "label" equals the component value; remove it');
});

test("an identical $variable override is redundant", async () => {
  assert.deepEqual(props(await cmp5("variable.fail")), ["descendants.label.fill"]);
});

test("#fff vs #FFFFFF is redundant; #fff vs $white is not", async () => {
  assert.deepEqual(props(await cmp5("colour-case.fail")), ["descendants.label.fill"]);
  assert.deepEqual(await cmp5("var-vs-literal.pass"), []);
});

test("a different value is not redundant", async () => {
  assert.deepEqual(await cmp5("different.pass"), []);
});

test("an equal nested paint object is redundant, whatever the key order and colour case", async () => {
  assert.deepEqual(props(await cmp5("paint.fail")), ["descendants.label.stroke"]);
});

test("non-colour strings are compared exactly", async () => {
  assert.deepEqual(await cmp5("text-colour.pass"), []);
});

test("the fix removes the override key", async () => {
  const out = await cmp5("literal.fail");
  assert.deepEqual(out[0]?.fix, { type: "remove", prop: "descendants.label.content" });
});

test("it is silent unless configured, or when switched off; severity override does not apply to info", async () => {
  for (const raw of [undefined, {}, { rules: { "TOK-005": {} } }, { rules: { "CMP-005": { severity: "off" } } }]) assert.deepEqual(await load("literal.fail", raw), []);
  const out = await cmp5("literal.fail", { rules: { "CMP-005": { severity: "block" } } });
  assert.equal(out[0]?.severity, "info");
});

test("the rule's own output is sorted and (nodeId, prop) is unique", async () => {
  const compiled = await compileFixture("CMP-005/multi.fail.pen");
  const out = registry.find((r) => r.id === "CMP-005")!.run(compiled, config(ON));
  assert.deepEqual(props(out), ["descendants.label.enabled", "descendants.label.fill", "descendants.label.opacity"]);
  assert.equal(new Set(out.map((v) => `${v.nodeId}\0${v.prop}`)).size, out.length);
  assert.deepEqual(out, registry.find((r) => r.id === "CMP-005")!.run(compiled, config(ON)));
});

test("a nested instance inside a component is reported once, not for each copy", async () => {
  const out = await cmp5("nested.fail");
  assert.deepEqual(out.map((v) => `${v.nodeId}:${v.prop}`), ["inner:descendants.label.content"]);
});
