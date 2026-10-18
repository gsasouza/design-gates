import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compile, DEFAULT_CONFIG, parsePen, registry, resolveConfig, type CompiledDocument, type GatesConfig, type Violation } from "../src/index.js";
import { gateFixture } from "./helpers/gates.js";

const rule = registry.find((r) => r.id === "DIF-004")!;
const cd = (children: unknown[], version = "2.6"): CompiledDocument => compile(parsePen(JSON.stringify({ version, children })), { file: "x.pen" });
const frame = (id: string, name: string, children: unknown[] = []): unknown => ({ id, type: "frame", name, children });
const text = (id: string, content = "x", fill = "#111111"): unknown => ({ id, type: "text", content, fill });
const texts = (prefix: string, n: number): unknown[] => Array.from({ length: n }, (_, i) => text(`${prefix}${String(i).padStart(2, "0")}`, `t${i}`));
const cfg = (dif: Record<string, unknown> = {}): GatesConfig => {
  const r = resolveConfig({ rules: { "DIF-004": dif } });
  assert.ok("config" in r);
  return r.config;
};
const run = (base: CompiledDocument | undefined, head: CompiledDocument, config: GatesConfig = cfg()): Violation[] => rule.run(head, config, { ...(base && { base }), head });
const load = async (name: string): Promise<CompiledDocument> => compile(parsePen(await readFile(gateFixture(`DIF-004/${name}.pen`), "utf8")), { file: `DIF-004/${name}.pen` });
const churn = (n: number): Violation[] => run(cd([frame("f", "Home", texts("a", n))]), cd([frame("f", "Home", texts("b", n))]));

test("DIF-004 is a registered opt-in warn rule", () => {
  assert.equal(rule.defaultSeverity, "warn");
  assert.equal(DEFAULT_CONFIG.rules["DIF-004"].enabled, false);
  assert.equal(DEFAULT_CONFIG.rules["DIF-004"].maxRecreated, 10);
  assert.equal(cfg().rules["DIF-004"].enabled, true);
});

test("threshold: below maxRecreated is silent, at it fires", () => {
  assert.deepEqual(churn(9), []);
  const [v, ...rest] = churn(10);
  assert.equal(rest.length, 0);
  assert.deepEqual([v!.rule, v!.severity, v!.nodeId, v!.path, v!.file], ["DIF-004", "warn", "#document", "#document", "x.pen"]);
  assert.match(v!.message, /^Id churn: 10 nodes recreated with a new id; e\.g\. a00 -> b00, a01 -> b01/);
  assert.equal(run(cd([frame("f", "H", texts("a", 2))]), cd([frame("f", "H", texts("b", 2))]), cfg({ maxRecreated: 2 })).length, 1);
  assert.equal(run(cd([frame("f", "H", texts("a", 2))]), cd([frame("f", "H", texts("b", 2))]), cfg({ maxRecreated: 3 })).length, 0);
});

test("pairing is one-to-one: two removed + one added of the same hash is one pair", () => {
  const base = cd([frame("f", "H", [text("r1"), text("r2")])]);
  const head = cd([frame("f", "H", [text("n1")])]);
  const [v] = run(base, head, cfg({ maxRecreated: 1 }));
  assert.match(v!.message, /^Id churn: 1 node recreated with a new id; e\.g\. r1 -> n1$/);
});

test("a different hash is not recreated", () => {
  const base = cd([frame("f", "H", [text("r1", "x", "#111111")])]);
  const head = cd([frame("f", "H", [text("n1", "x", "#222222")])]);
  assert.deepEqual(run(base, head, cfg({ maxRecreated: 1 })), []);
});

test("a node moved between two top-level frames is not recreated", () => {
  const base = cd([frame("f1", "One", [text("m"), text("k1", "a")]), frame("f2", "Two", [text("k2", "b")])]);
  const head = cd([frame("f1", "One", [text("k1", "a")]), frame("f2", "Two", [text("k2", "b"), text("m")])]);
  assert.deepEqual(run(base, head, cfg({ maxRecreated: 1 })), []);
});

test("sample is capped at 10, sorted", () => {
  const [v] = run(cd([frame("f", "H", texts("a", 12))]), cd([frame("f", "H", texts("b", 12))]), cfg());
  const sample = v!.message.split("e.g. ")[1]!;
  assert.equal(sample.split(" -> ").length - 1, 10);
  assert.match(sample, /a09 -> b09 \(\+2 more\)$/);
  assert.ok(!sample.includes("a10"));
});

test("version-only rewrite fires, even below the threshold", () => {
  const base = cd([frame("f", "H", [text("a1")])], "2.1");
  const head = cd([frame("f", "H", [text("b1")])], "2.2");
  const [v] = run(base, head);
  assert.match(v!.message, /^Id churn: 1 node recreated with a new id; version 2\.1 -> 2\.2 with no semantic change; e\.g\. a1 -> b1$/);
});

test("a version change with a real semantic change is not a version-only rewrite", () => {
  const base = cd([frame("f", "H", [text("a1", "x", "#111111")])], "2.1");
  const head = cd([frame("f", "H", [text("a1", "x", "#222222")])], "2.2");
  assert.deepEqual(run(base, head), []);
});

test("a version change with no node change is not reported; a same-version id rewrite is not version-only", () => {
  assert.deepEqual(run(cd([frame("f", "H", [text("a1")])], "2.1"), cd([frame("f", "H", [text("a1")])], "2.2")), []);
  assert.deepEqual(run(cd([frame("f", "H", [text("a1")])]), cd([frame("f", "H", [text("b1")])])), []);
});

test("version bump plus id rewrite with an instance fires", () => {
  const comp = (id: string): unknown => ({ id, type: "frame", name: "Button", reusable: true, children: [text(`${id}-l`)] });
  const inst = (id: string, ref: string): unknown => ({ id, type: "ref", ref, descendants: { [`${ref}-l`]: { content: "Go" } } });
  const base = cd([comp("btn"), frame("s", "Screen", [inst("i1", "btn")])], "2.1");
  const head = cd([comp("btn2"), frame("s", "Screen", [inst("i2", "btn2")])], "2.2");
  const out = run(base, head);
  assert.equal(out.length, 1);
  assert.match(out[0]!.message, /version 2\.1 -> 2\.2 with no semantic change/);
});

test("both triggers together give a single finding", () => {
  const out = run(cd([frame("f", "H", texts("a", 10))], "2.1"), cd([frame("f", "H", texts("b", 10))], "2.2"));
  assert.equal(out.length, 1);
  assert.match(out[0]!.message, /10 nodes recreated.*version 2\.1 -> 2\.2/);
});

test("no diff or no base: nothing", () => {
  const head = cd([frame("f", "H", texts("b", 10))]);
  assert.deepEqual(rule.run(head, cfg()), []);
  assert.deepEqual(run(undefined, head), []);
});

test("fixtures", async () => {
  for (const [name, expected] of [["churn.fail", 1], ["churn.pass", 0], ["version.fail", 1], ["version.pass", 0]] as const) {
    assert.equal(run(await load(`${name}.base`), await load(`${name}.head`)).length, expected, name);
  }
});

test("not configured: the runner does not run it; configured: it does", async () => {
  const { runRules } = await import("../src/rules/index.js");
  const base = cd([frame("f", "H", texts("a", 10))]);
  const head = cd([frame("f", "H", texts("b", 10))]);
  const input = [{ file: "x.pen", compiled: head, diff: { base, head } }];
  assert.deepEqual(runRules(input, DEFAULT_CONFIG).filter((v) => v.rule === "DIF-004"), []);
  assert.equal(runRules(input, cfg()).filter((v) => v.rule === "DIF-004").length, 1);
});

test("config validation for maxRecreated", () => {
  assert.equal(cfg({ maxRecreated: 3 }).rules["DIF-004"].maxRecreated, 3);
  for (const bad of [0, 1.5, "3", -1, null]) {
    const r = resolveConfig({ rules: { "DIF-004": { maxRecreated: bad } } });
    assert.ok(!("config" in r) || JSON.stringify(r).includes("DIF-004.maxRecreated"), String(bad));
    assert.ok(JSON.stringify(r).includes("rules.DIF-004.maxRecreated"), String(bad));
  }
});
