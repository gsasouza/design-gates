import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultFs } from "../src/cli/run-diff.js";
import { runCheck } from "../src/cli/run-check.js";
import { resolveConfig, runRules, type GatesConfig, type Violation } from "../src/index.js";
import { compileFixture } from "./helpers/gates.js";
import { createFixtureRepo } from "./helpers/fixture-repo.js";

const ON = { rules: { "TOK-005": {} } };
const config = (raw?: unknown): GatesConfig => {
  const r = resolveConfig(raw);
  assert.ok("config" in r, JSON.stringify(r));
  return r.config;
};

async function run(rule: "TOK-001" | "TOK-005", name: string, raw?: unknown): Promise<Violation[]> {
  const file = `TOK-005/${name}.pen`;
  const compiled = await compileFixture(file);
  return runRules([{ file, compiled }], config(raw)).filter((v) => v.rule === rule);
}
const tok5 = (name: string, raw?: unknown): Promise<Violation[]> => run("TOK-005", name, raw);
const summary = (vs: Violation[]): string[] => vs.map((v) => `${v.nodeId}:${v.prop}:${v.severity}`);

test("a raw colour equal to a token is reported with a replace fix; a number matches a spacing token", async () => {
  const out = await tok5("raw.fail", ON);
  assert.deepEqual(summary(out), ["box:fill:block", "stack:gap:warn"]);
  assert.equal(out[0]?.message, "fill #e5484d equals token $danger; bind the variable so token changes propagate");
  assert.deepEqual(out[0]?.fix, { type: "replace", prop: "fill", value: "$danger" });
  assert.deepEqual(out[1]?.fix, { type: "replace", prop: "gap", value: "$space-8" });
  assert.equal(out[1]?.message, "gap 8 equals token $space-8; bind the variable so token changes propagate");
  assert.equal(out[0]?.path, "screen/box");
});

test("several tokens are listed sorted and offered as candidates", async () => {
  const out = await tok5("two-tokens.fail", ON);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.message, "fill #FF0000FF equals token $a-red, $b-red; bind the variable so token changes propagate");
  assert.deepEqual(out[0]?.fix, { type: "candidates", prop: "fill", candidates: ["$a-red", "$b-red"] });
});

test("a themed variable matches only in the theme where it has that value", async () => {
  const out = await tok5("themed.fail", ON);
  assert.deepEqual(out.map((v) => [v.nodeId, v.theme]), [["in-dark", undefined]]);
  assert.deepEqual(out[0]?.fix, { type: "replace", prop: "fill", value: "$accent" });
});

test("bound variables and literals without a matching token give no TOK-005, the latter stay TOK-001", async () => {
  assert.deepEqual(await tok5("bound.pass", ON), []);
  assert.deepEqual(summary(await run("TOK-001", "bound.pass", ON)), ["other:fill:block"]);
  assert.deepEqual(summary(await run("TOK-001", "raw.fail", ON)), ["other:cornerRadius:warn", "other:fill:block"]);
});

test("TOK-005 is opt-in and leaves TOK-001 untouched when off", async () => {
  const baseline = summary(await run("TOK-001", "raw.fail"));
  assert.deepEqual(baseline, ["box:fill:block", "other:cornerRadius:warn", "other:fill:block", "stack:gap:warn"]);
  const offs: unknown[] = [undefined, {}, { rules: { "TOK-001": {} } }, { rules: { "TOK-005": { severity: "off" } } }];
  for (const raw of offs) {
    assert.deepEqual(await tok5("raw.fail", raw), []);
    assert.deepEqual(await run("TOK-001", "raw.fail", raw), await run("TOK-001", "raw.fail"));
  }
});

test("takeover: with TOK-005 on, each slot yields one finding and TOK-001 keeps only unmatched literals", async () => {
  const five = await tok5("raw.fail", ON);
  const one = await run("TOK-001", "raw.fail", ON);
  assert.deepEqual(summary(one), ["other:cornerRadius:warn", "other:fill:block"]);
  const keys = new Set([...five, ...one].map((v) => `${v.nodeId}:${v.prop}`));
  assert.equal(keys.size, five.length + one.length);
});

test("severity matches TOK-001 per property and can be overridden", async () => {
  const ones = await run("TOK-001", "raw.fail");
  for (const v of await tok5("raw.fail", ON)) assert.equal(v.severity, ones.find((o) => o.nodeId === v.nodeId && o.prop === v.prop)?.severity);
  assert.deepEqual(summary(await tok5("raw.fail", { rules: { "TOK-005": { severity: "warn" } } })), ["box:fill:warn", "stack:gap:warn"]);
  assert.deepEqual(summary(await tok5("raw.fail", { rules: { "TOK-005": { severity: "block" } } })), ["box:fill:block", "stack:gap:block"]);
});

test("properties narrows what is checked and is validated like TOK-001", async () => {
  assert.deepEqual(summary(await tok5("raw.fail", { rules: { "TOK-005": { properties: ["gap"] } } })), ["stack:gap:warn"]);
  // fill is no longer owned by TOK-005, so TOK-001 reports it again
  assert.ok(summary(await run("TOK-001", "raw.fail", { rules: { "TOK-005": { properties: ["gap"] } } })).includes("box:fill:block"));
  assert.ok("error" in (resolveConfig({ rules: { "TOK-005": { properties: ["margin"] } } }) as object));
  assert.deepEqual(config(ON).rules["TOK-005"].properties, config().rules["TOK-001"].properties);
});

test("inherited component literals are reported once on the definition, overrides on the instance", async () => {
  const out = await tok5("inherited.fail", ON);
  assert.deepEqual(out.map((v) => [v.nodeId, v.affectedInstances]), [["b3", undefined], ["btn", ["b1", "b2", "b3"]]]);
  assert.deepEqual(out[1]?.fix, { type: "replace", prop: "fill", value: "$brand" });
});

test("TOK-001 onlyIn and ignoreValues also exclude slots from TOK-005", async () => {
  const only = { rules: { "TOK-005": {}, "TOK-001": { onlyIn: ["Alpha"] } } };
  assert.deepEqual(summary(await tok5("scopes.fail", only)), ["inA:fill:block"]);
  const ignore = { rules: { "TOK-005": {}, "TOK-001": { ignoreValues: { fill: ["#111111"] } } } };
  assert.deepEqual(summary(await tok5("scopes.fail", ignore)), ["inB:fill:block"]);
  assert.deepEqual(summary(await run("TOK-001", "scopes.fail", ignore)), []);
});

// --- end to end through `check`: baseline and suppression aliases

interface Out {
  code: number;
  violations: Record<string, unknown>[];
}

async function check(repo: string, update = false): Promise<Out> {
  let out = "";
  const code = await runCheck({ updateBaseline: update }, { cwd: repo, stdout: (t) => (out += t), stderr: () => {}, fs: defaultFs });
  return { code, violations: out.startsWith("{") ? (JSON.parse(out) as Out).violations as never : [] };
}

async function withRepo(head: string, fn: (repo: string) => Promise<void>): Promise<void> {
  const r = await createFixtureRepo({ base: "check/clean", head });
  try {
    await fn(r.path);
  } finally {
    await r.cleanup();
  }
}

const baselineFile = (repo: string): string => path.join(repo, "design-gates-baseline.json");
const enable = (repo: string): Promise<void> => writeFile(path.join(repo, "design-gates.config.json"), JSON.stringify(ON));
const view = (o: Out): unknown[] => o.violations.map((v) => [v.rule, v.nodeId, v.baselined]);

test("a TOK-001 baseline still covers the slot once TOK-005 takes it over; new raw literals fail; update writes TOK-005", async () => {
  await withRepo("check/tok-raw", async (repo) => {
    const before = await check(repo, true);
    assert.equal(before.code, 0);
    assert.match(await readFile(baselineFile(repo), "utf8"), /"rule": "TOK-001"/);

    await enable(repo);
    const same = await check(repo);
    assert.equal(same.code, 0);
    assert.deepEqual(view(same), [["TOK-005", "box", true]]);
    assert.equal(same.violations[0]?.severity, "block");
  });
  await withRepo("check/tok-raw-two", async (repo) => {
    // baseline holds only `box` (as TOK-001); box2 is a new raw literal
    await writeFile(baselineFile(repo), JSON.stringify({ version: 1, entries: [{ file: "ui.pen", rule: "TOK-001", nodeId: "box", prop: "fill", theme: "" }] }));
    await enable(repo);
    const r = await check(repo);
    assert.equal(r.code, 1);
    assert.deepEqual(view(r), [["TOK-005", "box", true], ["TOK-005", "box2", undefined]]);

    await check(repo, true);
    const written = JSON.parse(await readFile(baselineFile(repo), "utf8")) as { entries: { rule: string }[] };
    assert.deepEqual(written.entries.map((e) => e.rule), ["TOK-005", "TOK-005"]);
    assert.equal((await check(repo)).code, 0);
  });
});

test("without TOK-005 enabled the baseline is matched as before (rule must be equal)", async () => {
  await withRepo("check/tok-raw", async (repo) => {
    await writeFile(baselineFile(repo), JSON.stringify({ version: 1, entries: [{ file: "ui.pen", rule: "TOK-005", nodeId: "box", prop: "fill", theme: "" }] }));
    const r = await check(repo);
    assert.equal(r.code, 1);
    assert.deepEqual(view(r), [["TOK-001", "box", undefined]]);
  });
});

test("the alias works for a node inside a themed frame (violations carry no theme)", async () => {
  await withRepo("check/tok-raw-themed", async (repo) => {
    assert.equal((await check(repo, true)).code, 0);
    await enable(repo);
    const r = await check(repo);
    assert.equal(r.code, 0);
    assert.deepEqual(view(r), [["TOK-005", "box", true]]);
    assert.equal(r.violations[0]?.theme, undefined);
  });
});

test("an ignore list naming TOK-001 also suppresses TOK-005 on the subtree", async () => {
  await withRepo("check/tok-raw-suppressed", async (repo) => {
    assert.deepEqual((await check(repo)).violations, []);
    await enable(repo);
    const r = await check(repo);
    assert.equal(r.code, 0);
    assert.deepEqual(r.violations, []);
  });
});
