import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, registry, resolveConfig, runRules, type GatesConfig, type Violation } from "../src/index.js";
import { runA11y004 } from "../src/rules/A11Y-004.js";
import { compileFixture } from "./helpers/gates.js";

const ON = { rules: { "A11Y-004": {} } };
const config = (raw?: unknown): GatesConfig => {
  const r = resolveConfig(raw);
  assert.ok("config" in r, JSON.stringify(r));
  return r.config;
};

async function run(name: string, raw: unknown = ON, rule = "A11Y-004"): Promise<Violation[]> {
  const file = `A11Y-004/${name}.pen`;
  const compiled = await compileFixture(file);
  return runRules([{ file, compiled }], config(raw)).filter((v) => v.rule === rule);
}
const summary = (vs: Violation[]): string[] => vs.map((v) => `${v.nodeId}.${v.prop}:${v.severity}`);

test("A11Y-004 is registered as an opt-in warn rule", () => {
  assert.equal(registry.find((e) => e.id === "A11Y-004")?.defaultSeverity, "warn");
});

test("text over an image warns with a message naming the kind", async () => {
  const out = await run("image.fail");
  assert.deepEqual(summary(out), ["label.fill:warn"]);
  assert.equal(out[0]?.message, "text sits over an image with no scrim; contrast cannot be guaranteed");
});

test("mesh_gradient, shader and background_blur backgrounds warn", async () => {
  const mesh = await run("mesh.fail");
  assert.deepEqual(summary(mesh), ["label.fill:warn"]);
  assert.match(mesh[0]!.message, /over a mesh gradient with no scrim/);
  const shader = await run("shader.fail");
  assert.deepEqual(summary(shader), ["label.fill:warn"]);
  assert.match(shader[0]!.message, /over a shader with no scrim/);
  const blur = await run("blur.fail");
  assert.deepEqual(summary(blur), ["label.fill:warn"]);
  assert.match(blur[0]!.message, /over a background blur with no scrim/);
});

test("a 0.5 alpha solid layer between image and text is a scrim", async () => {
  assert.deepEqual(await run("scrim.pass"), []);
});

test("a 0.1 alpha layer is below the scrim threshold", async () => {
  assert.deepEqual(summary(await run("weak-scrim.fail")), ["label.fill:warn"]);
});

test("the scrim's node opacity multiplies its alpha", async () => {
  // 0.627 * 0.4 = 0.25 < 0.3
  assert.deepEqual(summary(await run("opacity-scrim.fail")), ["label.fill:warn"]);
  // 0.8 * 0.5 = 0.4 >= 0.3
  assert.deepEqual(await run("opacity-scrim.pass"), []);
});

test("text over a plain solid, or an opaque layer above the image, is not reported", async () => {
  assert.deepEqual(await run("solid.pass"), []);
  assert.deepEqual(await run("opaque-between.pass"), []);
});

test("a fill array is a stack: a solid entry above the image is the scrim", async () => {
  assert.deepEqual(await run("fill-array-scrim.pass"), []);
  assert.deepEqual(summary(await run("fill-array.fail")), ["label.fill:warn"]);
});

test("a fill on the same node as background_blur sits above the blur", async () => {
  assert.deepEqual(await run("blur-fill-scrim.pass"), []);
});

test("a disabled image and a text without a visible fill are ignored", async () => {
  assert.deepEqual(await run("disabled-image.pass"), []);
  assert.deepEqual(await run("no-fill.pass"), []);
});

test("requireScrim=false turns the finding into a fixed-severity review", async () => {
  const out = await run("image.fail", { rules: { "A11Y-004": { requireScrim: false } } });
  assert.deepEqual(summary(out), ["label.fill:review"]);
  assert.equal(out[0]?.fixedSeverity, true);
  const forced = await run("image.fail", { rules: { "A11Y-004": { requireScrim: false, severity: "block" } } });
  assert.equal(forced[0]?.severity, "review");
  assert.deepEqual(await run("scrim.pass", { rules: { "A11Y-004": { requireScrim: false } } }), []);
});

test("requireScrim must be a boolean", () => {
  const r = resolveConfig({ rules: { "A11Y-004": { requireScrim: "yes" } } });
  assert.ok("error" in r);
});

test("it is silent when not enabled", async () => {
  const compiled = await compileFixture("A11Y-004/image.fail.pen");
  assert.deepEqual(runRules([{ file: "x.pen", compiled }], DEFAULT_CONFIG).filter((v) => v.rule === "A11Y-004"), []);
  assert.deepEqual(await run("image.fail", {}), []);
  assert.deepEqual(await run("image.fail", { rules: { "A11Y-001": {} } }), []);
  assert.deepEqual(await run("image.fail", { rules: { "A11Y-004": { severity: "off" } } }), []);
});

test("output is sorted and (nodeId, prop) is unique", async () => {
  const out = await run("multi.fail");
  assert.deepEqual(summary(out), ["a.fill:warn", "b.fill:warn"]);
  const keys = out.map((v) => `${v.rule}|${v.nodeId}|${v.prop}`);
  assert.equal(new Set(keys).size, keys.length);
});

test("a component-owned result is reported once on the definition with its instances", async () => {
  const out = await run("component.fail");
  assert.deepEqual(summary(out), ["badge-label.fill:warn"]);
  assert.deepEqual(out[0]?.affectedInstances, ["b1", "b2"]);
});

test("A11Y-001 is unchanged by A11Y-004; the only warn comes from A11Y-004", async () => {
  for (const name of ["image.fail", "mesh.fail", "shader.fail", "fill-array.fail"]) {
    const file = `A11Y-004/${name}.pen`;
    const compiled = await compileFixture(file);
    const both = runRules([{ file, compiled }], config({ rules: { "A11Y-001": {}, "A11Y-004": {} } }));
    const only = runRules([{ file, compiled }], config({ rules: { "A11Y-001": {} } }));
    assert.deepEqual(both.filter((v) => v.rule === "A11Y-001"), only.filter((v) => v.rule === "A11Y-001"), name);
    assert.deepEqual(both.filter((v) => v.severity === "warn").map((v) => v.rule), ["A11Y-004"], name);
  }
});

test("the rule itself returns findings sorted by nodeId then prop", async () => {
  const compiled = await compileFixture("A11Y-004/multi.fail.pen");
  assert.deepEqual(summary(runA11y004(compiled, config(ON))), ["a.fill:warn", "b.fill:warn"]);
});

test("an opaque white card between the image and the text ends the walk", async () => {
  assert.deepEqual(await run("card-over-image.pass"), []);
});

test("a disabled background_blur effect is ignored", async () => {
  assert.deepEqual(await run("blur-disabled.pass"), []);
});
