import { test } from "node:test";
import assert from "node:assert/strict";
import { registry, resolveConfig, runRules, type GatesConfig, type Violation } from "../src/index.js";
import { parseBaseline, serializeBaseline, entryOf, fingerprint } from "../src/check/baseline.js";
import { compileFixture } from "./helpers/gates.js";

const rsp = (breakpoints: unknown, extra: Record<string, unknown> = {}) => ({ rules: { "RSP-001": { breakpoints, ...extra } } });
const ON = rsp(["mobile", "tablet"]);
const config = (raw?: unknown): GatesConfig => {
  const r = resolveConfig(raw);
  assert.ok("config" in r, JSON.stringify(r));
  return r.config;
};

async function run(name: string, raw?: unknown): Promise<Violation[]> {
  const file = `RSP-001/${name}.pen`;
  const compiled = await compileFixture(file);
  return runRules([{ file, compiled }], config(raw)).filter((v) => v.rule === "RSP-001");
}
const summary = (vs: Violation[]): string[] => vs.map((v) => `${v.nodeId}:${v.prop}:${v.severity}`);

test("missing breakpoint frames give one finding each", async () => {
  const out = await run("missing.fail", ON);
  assert.deepEqual(summary(out), ["cart:breakpoints.tablet:warn", "checkout:breakpoints.mobile:warn", "checkout:breakpoints.tablet:warn"]);
  assert.equal(out[1]?.message, 'Screen "Checkout" has no "mobile" breakpoint frame');
  assert.equal(out[1]?.path, "checkout");
  assert.equal(out[1]?.fix, undefined);
});

test("naming and variant metadata both count", async () => {
  assert.deepEqual(await run("covered.pass", ON), []);
});

test("RSP-001 is opt-in: no config, no key, or severity off never reports", async () => {
  assert.deepEqual(await run("missing.fail"), []);
  assert.deepEqual(await run("missing.fail", { rules: { "TOK-001": {} } }), []);
  assert.deepEqual(await run("missing.fail", {}), []);
  assert.deepEqual(await run("missing.fail", rsp(["mobile"], { severity: "off" })), []);
});

test("baseBreakpoint: the base frame satisfies it; without it the breakpoint is missing", async () => {
  assert.deepEqual(await run("base.pass", rsp(["mobile", "tablet"], { baseBreakpoint: "mobile" })), []);
  assert.deepEqual(summary(await run("base.pass", ON)), ["checkout:breakpoints.mobile:warn"]);
});

test("baseBreakpoint matches the breakpoint name case-insensitively", async () => {
  assert.deepEqual(await run("base.pass", rsp(["Mobile", "tablet"], { baseBreakpoint: "mobile" })), []);
});

test("width configured and matching gives nothing", async () => {
  const bps = [{ name: "mobile", width: 375 }, { name: "tablet", width: 768 }];
  assert.deepEqual(await run("covered.pass", rsp(bps)), []);
  assert.deepEqual(await run("base.pass", rsp(bps, { baseBreakpoint: "mobile" })), []);
});

test("width mismatch is a separate finding on the breakpoint frame", async () => {
  const out = await run("width.fail", rsp([{ name: "mobile", width: 375 }, { name: "tablet", width: 768 }]));
  assert.deepEqual(summary(out), ["checkout-m:width:warn", "checkout-t:width:warn"]);
  assert.equal(out[0]?.message, 'Breakpoint frame "Checkout @ mobile" is 390 wide; "mobile" expects 375');
  assert.equal(out[1]?.message, 'Breakpoint frame "Checkout @ tablet" is fill_container wide; "tablet" expects 768');
});

test("width mismatch on the base frame for baseBreakpoint", async () => {
  const out = await run("width.fail", rsp([{ name: "desktop", width: 1280 }, "mobile", "tablet"], { baseBreakpoint: "desktop" }));
  assert.deepEqual(summary(out), ["checkout:width:warn"]);
  assert.equal(out[0]?.message, 'Breakpoint frame "Checkout" is 1440 wide; "desktop" expects 1280');
});

test("without a configured width only presence is checked", async () => {
  assert.deepEqual(await run("width.fail", ON), []);
});

test("state variants are not screens and need no breakpoint frames", async () => {
  assert.deepEqual(await run("state.pass", rsp(["mobile"])), []);
});

test("a top-level reusable component gets no finding", async () => {
  assert.deepEqual(await run("component.pass", rsp(["mobile"])), []);
});

test("screens globs narrow the checked screens", async () => {
  const out = await run("missing.fail", rsp(["mobile", "tablet"], { screens: ["Check*"] }));
  assert.deepEqual(out.map((v) => v.nodeId), ["checkout", "checkout"]);
  assert.deepEqual(await run("missing.fail", rsp(["mobile"], { screens: ["nothing*"] })), []);
  assert.deepEqual((await run("missing.fail", rsp(["tablet"], { screens: ["cart"] }))).map((v) => v.nodeId), ["cart"]);
});

test("custom pattern", async () => {
  assert.deepEqual(summary(await run("missing.fail", rsp(["mobile"], { pattern: "{name} @ {breakpoint}" }))), ["checkout:breakpoints.mobile:warn"]);
  // "Cart @ mobile" no longer matches, so it is a screen of its own.
  assert.deepEqual((await run("missing.fail", rsp(["mobile"], { pattern: "{name} - {breakpoint}" }))).map((v) => v.nodeId), ["cart", "cart-mobile", "checkout"]);
});

test("severity override", async () => {
  assert.deepEqual(summary(await run("missing.fail", rsp(["mobile"], { severity: "block" }))), ["checkout:breakpoints.mobile:block"]);
});

test("config validation", () => {
  const bad: unknown[] = [
    {},
    { breakpoints: [] },
    { breakpoints: "mobile" },
    { breakpoints: [""] },
    { breakpoints: [3] },
    { breakpoints: ["mobile", "Mobile"] },
    { breakpoints: ["mobile", { name: "MOBILE", width: 1 }] },
    { breakpoints: [{ name: "mobile", width: 0 }] },
    { breakpoints: [{ name: "mobile", width: "375" }] },
    { breakpoints: [{ name: "mobile", width: -5 }] },
    { breakpoints: ["  "] },
    { breakpoints: ["mobile", " mobile "] },
    { breakpoints: [{ name: "mobile", width: 1, foo: 1 }] },
    { breakpoints: [{ name: "mobile", width: NaN }] },
    { breakpoints: [{ name: "mobile", width: Infinity }] },
    { breakpoints: [{ width: 5 }] },
    { breakpoints: ["mobile"], baseBreakpoint: "tablet" },
    { breakpoints: ["mobile"], baseBreakpoint: 3 },
    { breakpoints: ["mobile"], pattern: "{name}" },
    { breakpoints: ["mobile"], pattern: "{breakpoint}" },
    { breakpoints: ["mobile"], screens: "x" },
    { breakpoints: ["mobile"], enabled: true },
  ];
  for (const rule of bad) assert.ok("error" in resolveConfig({ rules: { "RSP-001": rule } }), JSON.stringify(rule));
  const ok = resolveConfig(rsp(["mobile", { name: "tablet", width: 768 }], { baseBreakpoint: "Mobile" }));
  assert.ok("config" in ok);
  assert.equal(ok.config.rules["RSP-001"].enabled, true);
  const padded = resolveConfig(rsp(["mobile"], { baseBreakpoint: " Mobile " }));
  assert.ok("config" in padded);
  assert.equal(config().rules["RSP-001"].enabled, false);
});

test("the rule is in the registry", () => {
  const entry = registry.find((r) => r.id === "RSP-001");
  assert.equal(entry?.title, "Responsive frames present");
  assert.equal(entry?.defaultSeverity, "warn");
});

test("a baselined missing breakpoint is marked, a different missing one is not", async () => {
  const file = "RSP-001/missing.fail.pen";
  const baseline = parseBaseline(serializeBaseline(await run("missing.fail", rsp(["mobile"]))));
  const after = await run("missing.fail", ON);
  const flags = after.filter((v) => v.nodeId === "checkout").map((v) => [v.prop, baseline.has(fingerprint(entryOf({ ...v, file })))]);
  assert.deepEqual(flags, [["breakpoints.mobile", true], ["breakpoints.tablet", false]]);
});
