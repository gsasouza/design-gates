import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, registry, resolveConfig, runRules, type GatesConfig, type Violation } from "../src/index.js";
import { composite, contrastRatio, parseColor } from "../src/rules/a11y/color.js";
import { compileFixture } from "./helpers/gates.js";

async function check(name: string, config: GatesConfig = DEFAULT_CONFIG): Promise<Violation[]> {
  const compiled = await compileFixture(`A11Y-001/${name}.pen`);
  return runRules([{ file: `${name}.pen`, compiled }], config).filter((v) => v.rule === "A11Y-001");
}

test("A11Y-001 is registered as a blocking rule", () => {
  const entry = registry.find((e) => e.id === "A11Y-001");
  assert.equal(entry?.defaultSeverity, "block");
});

test("#9CA3AF on white reports exactly 2.54:1", async () => {
  const [v, ...rest] = await check("ratio-fail");
  assert.equal(rest.length, 0);
  assert.equal(v!.severity, "block");
  assert.equal(v!.nodeId, "label");
  assert.equal(v!.message, "contrast 2.54:1 < 4.5:1");
  assert.deepEqual(await check("ratio-pass"), []);
});

test("24px text uses the 3:1 threshold, 16px of the same color fails", async () => {
  const ratio = contrastRatio(parseColor("#909090")!, parseColor("#FFFFFF")!);
  assert.ok(ratio > 3.1 && ratio < 3.3, String(ratio));
  assert.deepEqual(await check("large-pass"), []);
  const [v] = await check("large-fail");
  assert.equal(v!.message, `contrast ${ratio.toFixed(2)}:1 < 4.5:1`);
});

test("config thresholds are honoured", async () => {
  const { config } = resolveConfig({ rules: { "A11Y-001": { minRatio: 2 } } }) as { config: GatesConfig };
  assert.deepEqual(await check("ratio-fail", config), []);
});

test("a semi-transparent background composes with its opaque ancestor", async () => {
  const bg = composite(parseColor("#00000080")!, parseColor("#FFFFFF")!);
  const expected = contrastRatio(composite(parseColor("#808080")!, bg), bg).toFixed(2);
  const [v, ...rest] = await check("alpha-fail");
  assert.equal(rest.length, 0);
  assert.equal(v!.message, `contrast ${expected}:1 < 4.5:1`);
  assert.deepEqual(await check("alpha-pass"), []);
});

test("an image background yields review, not a ratio", async () => {
  const [v, ...rest] = await check("image-review");
  assert.equal(rest.length, 0);
  assert.equal(v!.severity, "review");
  assert.equal(v!.nodeId, "label");
  const strict = resolveConfig({ rules: { "A11Y-001": { severity: "warn" } } }) as { config: GatesConfig };
  assert.equal((await check("image-review", strict.config))[0]!.severity, "review");
  assert.deepEqual(await check("image-pass"), []);
});

test("a theme-dependent color fails in one theme only", async () => {
  const [v, ...rest] = await check("theme-fail");
  assert.equal(rest.length, 0);
  assert.equal(v!.theme, "mode=dark");
  assert.deepEqual(await check("theme-pass"), []);
});

test("a gradient background reports the worst stop", async () => {
  const worst = contrastRatio(parseColor("#777777")!, parseColor("#555555")!).toFixed(2);
  const [v, ...rest] = await check("gradient-fail");
  assert.equal(rest.length, 0);
  assert.equal(v!.message, `contrast ${worst}:1 < 4.5:1`);
  assert.deepEqual(await check("gradient-pass"), []);
});

test("more than 16 theme combinations yields exactly one info violation", async () => {
  const out = await check("cap-fail");
  assert.equal(out.length, 1);
  const [v] = out;
  assert.equal(v!.severity, "info");
  assert.equal(v!.nodeId, "label");
  const keys: string[] = [];
  for (const a of ["a1", "a2", "a3"]) for (const b of ["b1", "b2", "b3"]) for (const c of ["c1", "c2"]) keys.push(`a=${a},b=${b},c=${c}`);
  keys.sort();
  assert.equal(
    v!.message,
    `A11Y-001 evaluated 16 of 18 theme combinations; evaluated: [${keys.slice(0, 16).join(", ")}]; skipped: [${keys.slice(16).join(", ")}]`,
  );
  const strict = resolveConfig({ rules: { "A11Y-001": { severity: "block" } } }) as { config: GatesConfig };
  assert.equal((await check("cap-fail", strict.config))[0]!.severity, "info");
});

test("16 combinations or fewer gets no info violation", async () => {
  assert.deepEqual(await check("cap-pass"), []);
});

test("a violation fully inside a component is reported once, with affectedInstances", async () => {
  const out = await check("component-fail");
  assert.equal(out.length, 1);
  assert.equal(out[0]!.nodeId, "badge-label");
  assert.deepEqual(out[0]!.affectedInstances, ["b1", "b2"]);
  assert.deepEqual(await check("component-pass"), []);
});

test("a result that depends on context is reported on the instance", async () => {
  const fail = await check("context-fail");
  assert.deepEqual(fail.map((v) => v.nodeId), ["t1::tag-label", "tag-label"]);
  assert.ok(fail.every((v) => v.affectedInstances === undefined));
  const dark = resolveConfig({ canvasColor: "#111111" }) as { config: GatesConfig };
  assert.deepEqual(await check("context-pass", dark.config), []);
});

test("output is deterministic", async () => {
  for (const name of ["theme-fail", "cap-fail", "component-fail", "gradient-fail"]) {
    assert.equal(JSON.stringify(await check(name)), JSON.stringify(await check(name)), name);
  }
});
