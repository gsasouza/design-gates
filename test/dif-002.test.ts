import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compile, DEFAULT_CONFIG, parsePen, registry, resolveConfig, type CompiledDocument, type GatesConfig, type Violation } from "../src/index.js";
import { ruleChanges } from "../src/diff/rule-changes.js";
import { defaultFs } from "../src/cli/run-diff.js";
import { runCheck, type CheckDeps } from "../src/cli/run-check.js";
import { createGitReader } from "../src/git/exec.js";
import type { GitReader } from "../src/git/reader.js";
import type { RuleEntry } from "../src/rules/index.js";
import { gateFixture } from "./helpers/gates.js";
import { createFixtureRepo } from "./helpers/fixture-repo.js";

const rule = registry.find((r) => r.id === "DIF-002")!;
const cd = (children: unknown[]): CompiledDocument => compile(parsePen(JSON.stringify({ version: "2.6", children })), { file: "x.pen" });
const frame = (id: string, name: string, children: unknown[] = []): unknown => ({ id, type: "frame", name, children });
const text = (id: string, content: string): unknown => ({ id, type: "text", content });
const cfg = (dif: Record<string, unknown>, extra: Record<string, unknown> = {}): GatesConfig => {
  const r = resolveConfig({ ...extra, rules: { "DIF-002": dif } });
  assert.ok("config" in r);
  return r.config;
};
const run = (base: CompiledDocument | undefined, head: CompiledDocument, config: GatesConfig): Violation[] => rule.run(head, config, { ...(base && { base }), head });
const load = async (name: string): Promise<CompiledDocument> => compile(parsePen(await readFile(gateFixture(`DIF-002/${name}.pen`), "utf8")), { file: `DIF-002/${name}.pen` });

test("helper: id-mode diff of a matched frame, sorted, with trees on both sides", () => {
  const base = cd([frame("f", "Home", [text("b", "1"), text("a", "1")])]);
  const head = cd([frame("f", "Home", [text("b", "2"), text("a", "1")])]);
  const [only, ...rest] = ruleChanges(base, head);
  assert.equal(rest.length, 0);
  assert.deepEqual(only!.changes, [{ id: "b", change: "modified" }]);
  assert.deepEqual([only!.baseId, only!.baseName, only!.headId, only!.headName, only!.headNodeId], ["f", "Home", "f", "Home", "f"]);
  assert.equal(only!.basePen?.children?.[0]?.id, "b");
  assert.equal(only!.headPen?.children?.[0]?.content, "2");
});

test("helper: a node recreated with a new id is removed + added, never modified", () => {
  const base = cd([frame("f", "Home", [text("old", "same")])]);
  const head = cd([frame("f", "Home", [text("new", "same")])]);
  assert.deepEqual(ruleChanges(base, head)[0]!.changes, [{ id: "new", change: "added" }, { id: "old", change: "removed" }]);
});

test("helper: added and removed frames contribute every node", () => {
  const base = cd([frame("gone", "Gone", [text("g1", "x")]), frame("keep", "Keep")]);
  const head = cd([frame("keep", "Keep"), frame("fresh", "Fresh", [frame("inner", "Inner", [text("t", "y")])])]);
  const out = ruleChanges(base, head);
  assert.deepEqual(out.map((f) => [f.baseId, f.headId]), [[undefined, "fresh"], ["gone", undefined], ["keep", "keep"]]);
  const added = out.find((f) => f.headId === "fresh")!;
  assert.deepEqual(added.changes, [{ id: "fresh", change: "added" }, { id: "inner", change: "added" }, { id: "t", change: "added" }]);
  assert.equal(added.basePen, undefined);
  const removed = out.find((f) => f.baseId === "gone")!;
  assert.deepEqual(removed.changes, [{ id: "g1", change: "removed" }, { id: "gone", change: "removed" }]);
  assert.equal(removed.headPen, undefined);
  assert.equal(removed.baseNodeId, "gone");
});

test("helper: component copies are skipped and the id-mode root change of a structure match is modified on the head id", () => {
  const comp = { id: "btn", type: "frame", name: "Button", reusable: true, children: [text("lbl", "Go")] };
  const base = cd([comp, frame("s", "Screen", [{ id: "i", type: "ref", ref: "btn" }])]);
  assert.deepEqual(ruleChanges(base, base).flatMap((f) => f.changes), []);
  // same shape, new frame id: matched by structure, only the root's id differs
  const renamed = cd([frame("f1", "Home", [text("t", "a")])]);
  const moved = cd([frame("f2", "Home", [text("t", "a")])]);
  const [pair] = ruleChanges(renamed, moved);
  assert.deepEqual([pair!.baseId, pair!.headId], ["f1", "f2"]);
  assert.deepEqual(pair!.changes, [{ id: "f2", change: "modified" }]);
});

test("DIF-002 is registered as an opt-in warn rule", () => {
  assert.equal(rule.title, "Out of scope");
  assert.equal(rule.defaultSeverity, "warn");
});

test("in scope by node id is silent; out of scope gives one finding per frame", async () => {
  const base = await load("scope.fail.base");
  const head = await load("scope.fail.head");
  assert.deepEqual(run(base, head, cfg({ scope: ["title", "cta", "s-note"] })), []);
  const pass = run(await load("scope.pass.base"), await load("scope.pass.head"), cfg({ scope: ["title"] }));
  assert.deepEqual(pass, []);
  const out = run(base, head, cfg({ scope: ["title"] }));
  assert.deepEqual(out.map((v) => [v.rule, v.severity, v.nodeId, v.path, v.prop]), [
    ["DIF-002", "warn", "home", "home", undefined],
    ["DIF-002", "warn", "settings", "settings", undefined],
  ]);
  assert.equal(out[0]!.message, 'Frame "Home" changed outside the declared scope: cta');
  assert.equal(out[1]!.message, 'Frame "Settings" changed outside the declared scope: s-note');
  assert.equal(new Set(out.map((v) => `${v.rule}|${v.nodeId}|${v.prop}`)).size, out.length);
});

test("a top-frame id or name (with glob) puts the whole frame in scope", async () => {
  const base = await load("scope.fail.base");
  const head = await load("scope.fail.head");
  assert.deepEqual(run(base, head, cfg({ scope: ["home", "Sett*"] })), []);
  assert.deepEqual(run(base, head, cfg({ scope: ["home"] })).map((v) => v.nodeId), ["settings"]);
  assert.deepEqual(run(base, head, cfg({ scope: ["*ings"] })).map((v) => v.nodeId), ["home"]);
});

test("a renamed frame stays in scope under its old name, or its new one", () => {
  const base = cd([frame("f", "Old name", [text("t", "1")])]);
  const head = cd([frame("f", "New name", [text("t", "2")])]);
  assert.deepEqual(run(base, head, cfg({ scope: ["Old name"] })), []);
  assert.deepEqual(run(base, head, cfg({ scope: ["New name"] })), []);
  assert.equal(run(base, head, cfg({ scope: ["Other"] })).length, 1);
});

test("the listed ids are capped at 10 with a (+N more) suffix", () => {
  const ids = Array.from({ length: 13 }, (_, i) => `n${String(i).padStart(2, "0")}`);
  const base = cd([frame("f", "Big")]);
  const head = cd([frame("f", "Big", ids.map((id) => text(id, "x")))]);
  const [v] = run(base, head, cfg({ scope: ["nothing"] }));
  assert.equal(v!.message, `Frame "Big" changed outside the declared scope: ${ids.slice(0, 10).join(", ")} (+3 more)`);
  const [exact] = run(base, cd([frame("f", "Big", ids.slice(0, 10).map((id) => text(id, "x")))]), cfg({ scope: ["nothing"] }));
  assert.doesNotMatch(exact!.message, /more/);
});

test("strict makes the finding a block", async () => {
  const base = await load("scope.fail.base");
  const head = await load("scope.fail.head");
  const out = run(base, head, cfg({ scope: ["title"] }, { strict: true }));
  assert.deepEqual(out.map((v) => v.severity), ["block", "block"]);
});

test("a removed frame is reported on its base id", () => {
  const base = cd([frame("gone", "Gone", [text("g", "x")]), frame("keep", "Keep")]);
  const head = cd([frame("keep", "Keep")]);
  const out = run(base, head, cfg({ scope: ["keep"] }));
  assert.deepEqual(out.map((v) => [v.nodeId, v.path, v.message]), [["gone", "gone", 'Frame "Gone" changed outside the declared scope: g, gone']]);
});

test("no diff, no base or an empty scope is silent; the rule only runs when configured", async () => {
  const base = await load("scope.fail.base");
  const head = await load("scope.fail.head");
  const on = cfg({ scope: ["title"] });
  assert.deepEqual(rule.run(head, on), []);
  assert.deepEqual(run(undefined, head, on), []);
  assert.deepEqual(run(base, head, cfg({})), []);
  assert.deepEqual(run(base, head, cfg({ scope: [] })), []);
  assert.equal(DEFAULT_CONFIG.rules["DIF-002"].enabled, false);
  assert.equal(cfg({}).rules["DIF-002"].enabled, true);
  const runner = await import("../src/rules/index.js");
  const off = runner.runRules([{ file: "x.pen", compiled: head, diff: { base, head } }], { ...DEFAULT_CONFIG, rules: { ...DEFAULT_CONFIG.rules, "DIF-002": { ...DEFAULT_CONFIG.rules["DIF-002"], scope: ["title"] } } });
  assert.deepEqual(off.filter((v) => v.rule === "DIF-002"), []);
  assert.equal(runner.runRules([{ file: "x.pen", compiled: head, diff: { base, head } }], on).filter((v) => v.rule === "DIF-002").length, 2);
});

test("config: defaults and validation", () => {
  assert.deepEqual(DEFAULT_CONFIG.rules["DIF-002"], { enabled: false, scope: [], scopeFile: ".pengate/scope.json" });
  const ok = cfg({ scope: ["a*"], scopeFile: "x/s.json" });
  assert.deepEqual([ok.rules["DIF-002"].scope, ok.rules["DIF-002"].scopeFile], [["a*"], "x/s.json"]);
  const bad: [unknown, RegExp][] = [
    [{ scope: "a" }, /rules.DIF-002.scope/],
    [{ scope: [1] }, /rules.DIF-002.scope/],
    [{ scopeFile: "" }, /rules.DIF-002.scopeFile/],
    [{ scopeFile: 3 }, /rules.DIF-002.scopeFile/],
  ];
  for (const [raw, re] of bad) {
    const r = resolveConfig({ rules: { "DIF-002": raw } });
    assert.ok("error" in r, JSON.stringify(raw));
    assert.match(r.error, re);
  }
});

// ---- run-check: the scope file ----

const SCOPE = ".pengate/scope.json";

/** A repo reader whose worktree reads of the given files are served from memory. */
function reader(repo: string, files: Record<string, string>): GitReader {
  const real = createGitReader(repo);
  return {
    ...real,
    async readWorktree(file: string) {
      if (file in files) return files[file]!;
      if (file === SCOPE || file === "design-gates.config.json" || file === "custom.json") throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      return real.readWorktree(file);
    },
  } as GitReader;
}

async function scopeSeen(files: Record<string, string>): Promise<{ code: number; err: string; seen: string[] | undefined; dif001: string[] | undefined }> {
  const r = await createFixtureRepo({ base: "check/fail", head: "check/clean" });
  try {
    let seen: string[] | undefined;
    let dif001: string[] | undefined;
    const spy: RuleEntry = { id: "CMP-001", title: "spy", description: "spy", defaultSeverity: "info", run: (_c, config) => ((seen = [...config.rules["DIF-002"].scope]), (dif001 = [...config.rules["DIF-001"].scope]), []) };
    let err = "";
    const deps: CheckDeps = { cwd: r.path, stdout: () => undefined, stderr: (t) => (err += t), fs: defaultFs, git: reader(r.path, files), entries: [spy] };
    const code = await runCheck({ scope: ["cli-scope"] }, deps);
    return { code, err, seen, dif001 };
  } finally {
    await r.cleanup();
  }
}

const cfgFile = (dif: unknown): Record<string, string> => ({ "design-gates.config.json": JSON.stringify({ rules: { "DIF-002": dif } }) });

test("run-check: the scope file replaces rules.DIF-002.scope; --scope only touches DIF-001", async () => {
  const r = await scopeSeen({ ...cfgFile({ scope: ["from-config"] }), [SCOPE]: '{"scope":["a","b*"]}' });
  assert.equal(r.code, 0);
  assert.deepEqual(r.seen, ["a", "b*"]);
  assert.deepEqual(r.dif001, ["cli-scope"]);
  const custom = await scopeSeen({ ...cfgFile({ scopeFile: "custom.json" }), "custom.json": '{"scope":["c"]}' });
  assert.deepEqual(custom.seen, ["c"]);
});

test("run-check: a missing default scope file keeps the config scope", async () => {
  const r = await scopeSeen(cfgFile({ scope: ["from-config"] }));
  assert.equal(r.code, 0);
  assert.deepEqual(r.seen, ["from-config"]);
});

test("run-check: the scope file is ignored when DIF-002 is not enabled", async () => {
  const r = await scopeSeen({ [SCOPE]: "not json" });
  assert.equal(r.code, 0);
  assert.deepEqual(r.seen, []);
});

test("run-check: a missing explicit scope file, bad JSON and a wrong shape are usage errors naming the file", async () => {
  const missing = await scopeSeen(cfgFile({ scopeFile: "custom.json" }));
  assert.equal(missing.code, 2);
  assert.match(missing.err, /custom\.json/);
  const json = await scopeSeen({ ...cfgFile({}), [SCOPE]: "{ nope" });
  assert.equal(json.code, 2);
  assert.match(json.err, /invalid JSON in scope file \.pengate\/scope\.json/);
  for (const body of ["[]", '{"scope":"a"}', '{"scope":[1]}', "{}", "null"]) {
    const shape = await scopeSeen({ ...cfgFile({}), [SCOPE]: body });
    assert.equal(shape.code, 2, body);
    assert.match(shape.err, /scope file \.pengate\/scope\.json/, body);
  }
});
