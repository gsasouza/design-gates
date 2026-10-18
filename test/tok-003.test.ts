import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultFs } from "../src/cli/run-diff.js";
import { applySuppressions } from "../src/check/suppress.js";
import { runCheck } from "../src/cli/run-check.js";
import { resolveConfig, runRules, type GatesConfig, type Violation } from "../src/index.js";
import { compileFixture } from "./helpers/gates.js";
import { createFixtureRepo } from "./helpers/fixture-repo.js";

const ON = { rules: { "TOK-003": {} } };
const config = (raw?: unknown): GatesConfig => {
  const r = resolveConfig(raw);
  assert.ok("config" in r, JSON.stringify(r));
  return r.config;
};

async function tok3(name: string, raw: unknown = ON): Promise<Violation[]> {
  const file = `TOK-003/${name}.pen`;
  const compiled = await compileFixture(file);
  return runRules([{ file, compiled }], config(raw)).filter((v) => v.rule === "TOK-003");
}
const summary = (vs: Violation[]): string[] => vs.map((v) => `${v.nodeId}:${v.prop}:${v.severity}`);
const all = { rules: { "TOK-003": { requireAllCombinations: true } } };

test("a variable missing dark and used by a dark node blocks", async () => {
  const out = await tok3("used-dark.fail");
  assert.deepEqual(summary(out), ["$var:bg:mode=dark:block"]);
  assert.equal(out[0]?.message, "Variable $bg has no value for mode=dark");
  assert.equal(out[0]?.path, "$var:bg");
  assert.equal(out[0]?.theme, "mode=dark");
  assert.equal(out[0]?.fix, undefined);
});

test("without a dark user there is no finding, requireAllCombinations warns", async () => {
  assert.deepEqual(await tok3("unused-combo.fail"), []);
  assert.deepEqual(summary(await tok3("unused-combo.fail", all)), ["$var:gap:density=compact,mode=dark:warn"]);
});

test("a variable with light only on a light+dark document is reported for dark", async () => {
  assert.deepEqual(summary(await tok3("axis-coverage.fail")), ["$var:bg:mode=dark:warn"]);
});

test("the axis-default combination is checked even when no node uses it", async () => {
  assert.deepEqual(summary(await tok3("default-theme.fail")), ["$var:gap:density=regular,mode=light:warn"]);
});

test("a fallback entry covers every value of its axis", async () => {
  assert.deepEqual(await tok3("covered.pass"), []);
  assert.deepEqual(await tok3("covered.pass", all), []);
});

test("an alias reports only the variable lacking the value", async () => {
  const out = await tok3("alias.fail");
  assert.deepEqual(summary(out), ["$var:gray-900:mode=dark:block"]);
});

test("an alias used by a dark node does not make an unrelated variable used", async () => {
  // gray-900 is warn when only reachable from a light user
  const compiled = await compileFixture("TOK-003/alias.fail.pen");
  const light = structuredClone(compiled);
  for (const n of light.nodes) n.theme = { mode: "light" };
  const out = runRules([{ file: "x.pen", compiled: light }], config(all)).filter((v) => v.rule === "TOK-003");
  assert.deepEqual(summary(out), ["$var:gray-900:mode=dark:warn"]);
});

test("multiple axes report the exact combination", async () => {
  assert.deepEqual(summary(await tok3("multi-axis.fail")), ["$var:gap:density=compact,mode=dark:block"]);
});

test("themeAxes restricts the axes checked", async () => {
  const only = (axes: string[]): unknown => ({ rules: { "TOK-003": { themeAxes: axes } } });
  assert.deepEqual(await tok3("multi-axis.fail", only(["mode"])), []);
  assert.deepEqual(summary(await tok3("multi-axis.fail", only(["density", "mode"]))), ["$var:gap:density=compact,mode=dark:block"]);
  assert.deepEqual(await tok3("multi-axis.fail", only(["nope"])), []);
});

test("scalar and fully covered variables give nothing", async () => {
  assert.deepEqual(await tok3("covered.pass", all), []);
});

test("TOK-003 is opt-in: a failing document gives no finding when it is not configured", async () => {
  for (const raw of [null, {}, { rules: { "TOK-001": {} } }, { rules: { "TOK-003": { severity: "off" } } }]) {
    assert.deepEqual(await tok3("used-dark.fail", raw), []);
  }
  assert.equal((await tok3("used-dark.fail", { rules: { "TOK-003": { severity: "warn" } } }))[0]?.severity, "warn");
});

test("findings are sorted and have unique baseline fingerprints", async () => {
  const out = await tok3("several.fail", all);
  assert.deepEqual(summary(out), [
    "$var:a:density=compact:warn",
    "$var:a:density=compact,mode=dark:warn",
    "$var:a:density=compact,mode=light:warn",
    "$var:a:density=regular,mode=dark:block",
    "$var:a:mode=dark:block",
    "$var:b:density=compact:warn",
    "$var:b:density=compact,mode=dark:warn",
    "$var:b:density=compact,mode=light:warn",
    "$var:b:density=regular,mode=dark:warn",
    "$var:b:mode=dark:warn",
  ]);

  const keys = out.map((v) => JSON.stringify([v.rule, v.nodeId, v.prop]));
  assert.equal(new Set(keys).size, out.length);
});

test("config options are validated", () => {
  for (const bad of [{ themeAxes: "mode" }, { themeAxes: [1] }, { requireAllCombinations: "yes" }]) {
    assert.ok("error" in (resolveConfig({ rules: { "TOK-003": bad } }) as object), JSON.stringify(bad));
  }
});

test("the check CLI prints, baselines and un-baselines a variable finding; node suppression does not apply", async () => {
  const repo = await createFixtureRepo({ base: "check/clean", head: "check/tok-incomplete" });
  try {
    const cfg = path.join(repo.path, "design-gates.config.json");
    await writeFile(cfg, JSON.stringify(ON));
    const run = async (options: Parameters<typeof runCheck>[0] = {}): Promise<{ code: number; out: string }> => {
      let out = "";
      const code = await runCheck(options, { cwd: repo.path, stdout: (t) => (out += t), stderr: () => undefined, fs: defaultFs });
      return { code, out };
    };
    const text = await run({ format: "text" });
    assert.equal(text.code, 1);
    assert.match(text.out, /ui\.pen#\$var:bg\.mode=dark: block TOK-003 Variable \$bg has no value for mode=dark/);
    const agent = JSON.parse((await run()).out) as { violations: Record<string, unknown>[] };
    assert.deepEqual(agent.violations.map((v) => [v.nodeId, v.path, v.theme]), [["$var:bg", "$var:bg", "mode=dark"]]);
    const sarif = JSON.parse((await run({ format: "sarif" })).out);
    assert.equal(sarif.runs[0].results[0].ruleId, "TOK-003");
    assert.equal(sarif.runs[0].results[0].locations[0].logicalLocations[0].fullyQualifiedName, "$var:bg");

    assert.equal((await run({ updateBaseline: true })).code, 0);
    const baseline = await readFile(path.join(repo.path, "design-gates-baseline.json"), "utf8");
    assert.match(baseline, /"nodeId": "\$var:bg"/);
    const after = await run();
    assert.equal(after.code, 0);
    assert.equal((JSON.parse(after.out) as { violations: Record<string, unknown>[] }).violations[0]?.baselined, true);
    assert.equal(JSON.parse((await run({ format: "sarif" })).out).runs[0].results[0].baselineState, "unchanged");

    // fixing the document prunes the entry again
    await writeFile(path.join(repo.path, "ui.pen"), await readFile(path.join(repo.path, "ui.pen"), "utf8").then((t) => t.replace('"theme": { "mode": "light" } }]', '"theme": { "mode": "light" } }, { "value": "#000", "theme": { "mode": "dark" } }]')));
    assert.equal((await run({ updateBaseline: true })).code, 0);
    assert.doesNotMatch(await readFile(path.join(repo.path, "design-gates-baseline.json"), "utf8"), /var:bg/);
  } finally {
    await repo.cleanup();
  }
});

test("node suppression markers never apply to a variable finding", async () => {
  const [violation] = await tok3("used-dark.fail");
  assert.ok(violation);
  const compiled = await compileFixture("TOK-003/used-dark.fail.pen");
  const byNode = new Map([["$var:bg", new Set(["TOK-003"])], ["dark", new Set(["TOK-003"])]]);
  assert.deepEqual(applySuppressions([violation], compiled, byNode), [violation]);
});
