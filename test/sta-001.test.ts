import { test } from "node:test";
import assert from "node:assert/strict";
import { registry, resolveConfig, runRules, type GatesConfig, type Violation } from "../src/index.js";
import { parseBaseline, serializeBaseline, entryOf, fingerprint } from "../src/check/baseline.js";
import { collectSuppressions } from "../src/check/suppress.js";
import { compile } from "../src/index.js";
import { compileFixture } from "./helpers/gates.js";

const ON = { rules: { "STA-001": {} } };
const config = (raw?: unknown): GatesConfig => {
  const r = resolveConfig(raw);
  assert.ok("config" in r, JSON.stringify(r));
  return r.config;
};

async function sta(name: string, raw?: unknown): Promise<Violation[]> {
  const file = `STA-001/${name}.pen`;
  const compiled = await compileFixture(file);
  return runRules([{ file, compiled }], config(raw)).filter((v) => v.rule === "STA-001");
}
const summary = (vs: Violation[]): string[] => vs.map((v) => `${v.nodeId}:${v.prop}:${v.severity}`);

test("a declared screen missing error and loading gets one finding per state", async () => {
  const out = await sta("screen.fail", ON);
  assert.deepEqual(summary(out), ["checkout:states.error:warn", "checkout:states.loading:warn"]);
  assert.equal(out[0]?.message, 'Screen "Checkout" has no "error" state variant');
  assert.equal(out[0]?.path, "checkout");
  assert.equal(out[0]?.fix, undefined);
});

test("a declared component misses a state; a top-level component is worded as Component", async () => {
  const out = await sta("component.fail", ON);
  assert.deepEqual(summary(out), ["card:states.loading:warn"]);
  assert.equal(out[0]?.message, 'Component "Card" has no "loading" state variant');
});

test("naming (case/space-insensitive) and variant metadata both count; variants are not bases", async () => {
  assert.deepEqual(await sta("covered.pass", ON), []);
  assert.deepEqual(await sta("undeclared.pass", ON), []);
});

test("STA-001 is opt-in: no config or a config without the key never runs it", async () => {
  assert.deepEqual(await sta("screen.fail"), []);
  assert.deepEqual(await sta("screen.fail", { rules: { "TOK-001": {} } }), []);
  assert.deepEqual(await sta("screen.fail", {}), []);
  assert.deepEqual(await sta("screen.fail", { rules: { "STA-001": { severity: "off" } } }), []);
});

test("screens globs declare data by name or id", async () => {
  const out = await sta("glob.fail", { rules: { "STA-001": { screens: ["Check*", "cart", "Cart *"] } } });
  assert.deepEqual(out.map((v) => v.nodeId), ["cart", "cart", "cart", "checkout", "checkout", "checkout"]);
  assert.equal((await sta("glob.fail", { rules: { "STA-001": { screens: ["nothing*"] } } })).length, 0);
});

test("custom pattern and states", async () => {
  assert.deepEqual(await sta("custom.pass", { rules: { "STA-001": { pattern: "{name} - {state}", states: ["empty", "offline"] } } }), []);
  const out = await sta("custom.pass", { rules: { "STA-001": { states: ["empty", "offline", "error"] } } });
  assert.equal(out.length, 3);
  assert.deepEqual(summary(await sta("custom.pass", { rules: { "STA-001": { pattern: "{name} - {state}", states: ["error"] } } })), ["checkout:states.error:warn"]);
});

test("severity override", async () => {
  const out = await sta("screen.fail", { rules: { "STA-001": { severity: "block" } } });
  assert.deepEqual(summary(out), ["checkout:states.error:block", "checkout:states.loading:block"]);
});

test("config validation", () => {
  const bad: unknown[] = [
    { states: [] },
    { states: "empty" },
    { states: [""] },
    { pattern: "{name}" },
    { pattern: "{state}" },
    { pattern: 3 },
    { screens: "x" },
    { enabled: true },
    { enabled: false },
  ];
  for (const rule of bad) assert.ok("error" in resolveConfig({ rules: { "STA-001": rule } }), JSON.stringify(rule));
  const ok = resolveConfig({ rules: { "STA-001": {} } });
  assert.ok("config" in ok);
  assert.equal(ok.config.rules["STA-001"].enabled, true);
  const defaults = config();
  assert.equal(defaults.rules["STA-001"].enabled, false);
});

test("the rule is in the registry", () => {
  const entry = registry.find((r) => r.id === "STA-001");
  assert.equal(entry?.title, "All states covered");
  assert.equal(entry?.defaultSeverity, "warn");
});

test("a states-only design-gates marker raises no SCH-001; an ignore list still needs a reason", () => {
  const mk = (metadata: unknown) => compile({ version: "2.6", children: [{ id: "f", type: "frame", width: 1, height: 1, metadata }] } as never, { file: "a.pen" });
  assert.deepEqual(collectSuppressions(mk({ type: "design-gates", states: true }), "a.pen").invalid, []);
  assert.deepEqual(collectSuppressions(mk({ type: "design-gates", variantOf: "x", state: "empty" }), "a.pen").invalid, []);
  assert.equal(collectSuppressions(mk({ type: "design-gates", ignore: ["TOK-001"] }), "a.pen").invalid.length, 1);
});

test("a baselined missing state is marked, a newly missing state is not", async () => {
  const file = "STA-001/screen.fail.pen";
  const before = await sta("screen.fail", { rules: { "STA-001": { states: ["empty", "error"] } } });
  const baseline = parseBaseline(serializeBaseline(before));
  const after = await sta("screen.fail", ON);
  const flags = after.map((v) => [v.prop, baseline.has(fingerprint(entryOf({ ...v, file })))]);
  assert.deepEqual(flags, [["states.error", true], ["states.loading", false]].map(([p, b]) => [p, b]));
});

test("variant matcher bypasses: unmatched/other-kind variantOf, wrong state and self reference do not count", async () => {
  const out = await sta("bypass.fail", ON);
  // shop: "error" is covered via variantOf by id; the ghost (unmatched variantOf), the
  // component (different kind) and its own self-referencing marker do not cover the rest.
  assert.deepEqual(summary(out), ["shop:states.empty:warn", "shop:states.loading:warn"]);
});

test("screens globs match regex metacharacters literally", async () => {
  const out = await sta("meta.fail", { rules: { "STA-001": { screens: ["Cart (1)", "a.b"], states: ["empty"] } } });
  assert.deepEqual(out.map((v) => v.nodeId), ["ab", "cart1"]);
});

test("screens globs match by compiled id as well as name", async () => {
  const out = await sta("meta.fail", { rules: { "STA-001": { screens: ["sid-*"], states: ["empty"] } } });
  assert.deepEqual(out.map((v) => v.nodeId), ["sid-only"]);
});

test("a variant matched by a screens glob never counts as declaring", async () => {
  const out = await sta("globvariant.fail", { rules: { "STA-001": { screens: ["Checkout*"] } } });
  assert.deepEqual(summary(out), ["checkout:states.error:warn", "checkout:states.loading:warn"]);
});

test("metadata variantOf matches the base display name", async () => {
  assert.deepEqual(await sta("refname.pass", ON), []);
});

test("a breakpoint variant never counts as declaring, even via a screens glob", async () => {
  const file = "RSP-001/covered.pass.pen";
  const compiled = await compileFixture(file);
  const raw = { rules: { "STA-001": { screens: ["Checkout*"], states: ["empty"] }, "RSP-001": { breakpoints: ["mobile", "tablet"] } } };
  const out = runRules([{ file, compiled }], config(raw)).filter((v) => v.rule === "STA-001");
  assert.deepEqual(summary(out), ["checkout:states.empty:warn"]);
});

test("a non-array ignore without a reason is reported; an empty ignore list is silent", () => {
  const mk = (metadata: unknown) => compile({ version: "2.6", children: [{ id: "f", type: "frame", width: 1, height: 1, metadata }] } as never, { file: "a.pen" });
  assert.equal(collectSuppressions(mk({ type: "design-gates", ignore: "TOK-001" }), "a.pen").invalid.length, 1);
  assert.deepEqual(collectSuppressions(mk({ type: "design-gates", ignore: [] }), "a.pen").invalid, []);
});

test("duplicate states, also case-variant ones, are a config error", () => {
  for (const states of [["empty", "empty"], ["empty", "Empty "]]) assert.ok("error" in resolveConfig({ rules: { "STA-001": { states } } }), JSON.stringify(states));
});
