import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultFs } from "../src/cli/run-diff.js";
import { defaultCheckDeps, runCheck, type CheckDeps, type CheckOptions } from "../src/cli/run-check.js";
import { registry, type RuleEntry } from "../src/rules/index.js";
import type { Violation } from "../src/gates/types.js";
import { createFixtureRepo } from "./helpers/fixture-repo.js";

interface Result {
  code: number;
  out: string;
  err: string;
}

async function check(repo: string, options: CheckOptions = {}, extra: Partial<CheckDeps> = {}): Promise<Result> {
  let out = "";
  let err = "";
  const code = await runCheck(options, { cwd: repo, stdout: (t) => (out += t), stderr: (t) => (err += t), fs: defaultFs, ...extra });
  return { code, out, err };
}

/** Repo whose worktree holds `dir`; its base commit is some other fixture, so the two commits differ. */
async function withRepo<T>(dir: string, fn: (repo: string) => Promise<T>, base = dir === "check/clean" ? "check/fail" : "check/clean"): Promise<T> {
  const r = await createFixtureRepo({ base, head: dir });
  try {
    return await fn(r.path);
  } finally {
    await r.cleanup();
  }
}

const parse = (r: Result): { violations: Record<string, unknown>[] } => JSON.parse(r.out) as { violations: Record<string, unknown>[] };

test("clean fixture exits 0, failing fixture exits 1", async () => {
  await withRepo("check/clean", async (repo) => {
    const r = await check(repo);
    assert.equal(r.code, 0);
    assert.deepEqual(parse(r).violations, []);
  });
  await withRepo("check/fail", async (repo) => {
    const r = await check(repo);
    assert.equal(r.code, 1);
    assert.deepEqual(parse(r).violations, [
      { rule: "SCH-002", severity: "block", file: "bad.pen", nodeId: "use", path: "f/use", message: 'Instance refers to missing node "ghost"' },
    ]);
  });
});

test("usage and config errors exit 2", async () => {
  await withRepo("check/clean", async (repo) => {
    assert.equal((await check(repo, { format: "xml" })).code, 2);
    assert.equal((await check(repo, { base: "no-such-ref" })).code, 2);
    assert.equal((await check(repo, { base: "--evil" })).code, 2);
    assert.equal((await check(repo, { paths: ["../outside.pen"] })).code, 2);
    assert.equal((await check(repo, { config: "/etc/passwd" })).code, 2);
    assert.equal((await check(repo, { config: "missing.json" })).code, 2);
    await writeFile(path.join(repo, "design-gates.config.json"), "{ nope");
    const r = await check(repo);
    assert.equal(r.code, 2);
    assert.match(r.err, /invalid JSON/);
    await writeFile(path.join(repo, "design-gates.config.json"), '{"rules":{"NOPE-1":{}}}');
    assert.match((await check(repo)).err, /invalid config/);
  });
});

test("the cli exits 2 on an unknown flag and prints the check usage", () => {
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const bad = spawnSync(process.execPath, [cli, "check", "--bogus"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.match(help.stdout, /--update-baseline/);
});

test("the cli runs check end to end", async () => {
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  await withRepo("check/fail", async (repo) => {
    const r = spawnSync(process.execPath, [cli, "check", "--format", "text"], { encoding: "utf8", cwd: repo });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /bad\.pen#f\/use: block SCH-002/);
  });
});

test("baseline hides a violation, --update-baseline writes and prunes", async () => {
  await withRepo("check/fail", async (repo) => {
    const file = path.join(repo, "design-gates-baseline.json");
    const updated = await check(repo, { updateBaseline: true });
    assert.equal(updated.code, 0);
    const text = await readFile(file, "utf8");
    assert.equal(text, `${JSON.stringify({ version: 1, entries: [{ file: "bad.pen", rule: "SCH-002", nodeId: "use", prop: "", theme: "" }] }, null, 2)}\n`);

    const r = await check(repo);
    assert.equal(r.code, 0);
    assert.equal(parse(r).violations[0]!.baselined, true);

    await writeFile(
      file,
      JSON.stringify({ version: 1, entries: [{ file: "bad.pen", rule: "SCH-002", nodeId: "use" }, { file: "gone.pen", rule: "SCH-001", nodeId: "x" }] }),
    );
    assert.equal((await check(repo)).code, 0);
    assert.equal(await readFile(file, "utf8"), JSON.stringify({ version: 1, entries: [{ file: "bad.pen", rule: "SCH-002", nodeId: "use" }, { file: "gone.pen", rule: "SCH-001", nodeId: "x" }] }), "without the flag the file is untouched");
    await check(repo, { updateBaseline: true });
    assert.equal(await readFile(file, "utf8"), text);
  });
});

test("an invalid baseline exits 2 and a symlinked baseline is not written", async () => {
  await withRepo("check/fail", async (repo) => {
    await writeFile(path.join(repo, "design-gates-baseline.json"), "[]");
    assert.equal((await check(repo)).code, 2);
  });
  await withRepo("check/fail", async (repo) => {
    await symlink("elsewhere.json", path.join(repo, "design-gates-baseline.json"));
    assert.equal((await check(repo, { updateBaseline: true })).code, 2);
  });
});

const themedRule: RuleEntry = {
  id: "A11Y-001",
  title: "Contrast",
  description: "Fake themed rule",
  defaultSeverity: "block",
  run: (): Violation[] =>
    ["dark", "light"].map((mode) => ({ rule: "A11Y-001", severity: "block", file: "", nodeId: "t", path: "f/t", prop: "fill", message: `low contrast in ${mode}`, theme: `mode=${mode}` })),
};

test("baselining the dark theme does not hide the light theme", async () => {
  await withRepo("check/clean", async (repo) => {
    const entries = [themedRule];
    await writeFile(
      path.join(repo, "design-gates-baseline.json"),
      JSON.stringify({ version: 1, entries: [{ file: "ok.pen", rule: "A11Y-001", nodeId: "t", prop: "fill", theme: "mode=dark" }] }),
    );
    const r = await check(repo, {}, { entries });
    assert.equal(r.code, 1);
    assert.deepEqual(parse(r).violations.map((v) => [v.theme, v.baselined]), [["mode=dark", true], ["mode=light", undefined]]);
  });
});

test("a suppression with a reason hides the violation, also for the subtree", async () => {
  for (const dir of ["check/suppressed", "check/nested"]) {
    await withRepo(dir, async (repo) => {
      const r = await check(repo);
      assert.equal(r.code, 0);
      assert.deepEqual(parse(r).violations, []);
    });
  }
});

test("a suppression without a reason is reported, blocks and suppresses nothing", async () => {
  await withRepo("check/suppressed-no-reason", async (repo) => {
    const r = await check(repo);
    assert.equal(r.code, 1);
    assert.deepEqual(parse(r).violations.map((v) => [v.rule, v.severity, v.message]), [
      ["SCH-001", "block", "design-gates suppression without reason"],
      ["SCH-002", "block", 'Instance refers to missing node "ghost"'],
    ]);
  });
});

const quietRule = (severity: Violation["severity"]): RuleEntry => ({
  id: "CMP-001",
  title: "Quiet",
  description: "Fake rule",
  defaultSeverity: severity,
  run: () => [{ rule: "CMP-001", severity, file: "", nodeId: "f", path: "f", message: "just so you know", fixedSeverity: true }],
});

test("info- and warn-only results exit 0", async () => {
  await withRepo("check/clean", async (repo) => {
    for (const severity of ["info", "warn", "review"] as const) {
      const r = await check(repo, {}, { entries: [quietRule(severity)] });
      assert.equal(r.code, 0, severity);
      assert.equal(parse(r).violations.length, 1);
    }
  });
});

test("--scope is appended to rules.DIF-001.scope", async () => {
  await withRepo("check/clean", async (repo) => {
    await writeFile(path.join(repo, "design-gates.config.json"), '{"rules":{"DIF-001":{"scope":["Button"]}}}');
    let seen: string[] = [];
    const spy: RuleEntry = { ...quietRule("info"), run: (_c, config) => ((seen = [...config.rules["DIF-001"].scope]), []) };
    await check(repo, { scope: ["Card", "color.*"] }, { entries: [spy] });
    assert.deepEqual(seen, ["Button", "Card", "color.*"]);
    await check(repo, {}, { entries: [spy] });
    assert.deepEqual(seen, ["Button"]);
  });
});

test("--base passes a diff context to the rules", async () => {
  await withRepo("check/clean-edited", async (repo) => {
    const seen: unknown[] = [];
    const spy: RuleEntry = { ...quietRule("info"), run: (_c, _cfg, diff) => (seen.push(diff && { base: diff.base?.file, head: diff.head.file, vars: diff.variables }), []) };
    const r = await check(repo, { base: "base" }, { entries: [spy] });
    assert.equal(r.code, 0);
    assert.deepEqual(seen, [{ base: "ok.pen", head: "ok.pen", vars: { variables: [], themes: [] } }]);
    seen.length = 0;
    await check(repo, {}, { entries: [spy] });
    assert.deepEqual(seen, [undefined]);
  }, "check/clean");
});

test("--base against a changed fixture reports the head violations", async () => {
  const r = await createFixtureRepo({ base: "check/clean", head: "check/fail" });
  try {
    assert.equal((await check(r.path, { base: "base" })).code, 1);
  } finally {
    await r.cleanup();
  }
});

test("paths narrow the files and an unparsable file is a file-level SCH-001", async () => {
  await withRepo("check/fail", async (repo) => {
    assert.equal((await check(repo, { paths: ["other/*.pen"] })).code, 0);
    assert.equal((await check(repo, { paths: ["./bad.pen"] })).code, 1);
    await writeFile(path.join(repo, "broken.pen"), "{");
    const r = parse(await check(repo));
    assert.deepEqual(r.violations.map((v) => [v.file, v.rule, v.nodeId]), [["bad.pen", "SCH-002", "use"], ["broken.pen", "SCH-001", ""]]);
  });
});

test("rules.SCH-001 off also silences the suppression-without-reason report", async () => {
  await withRepo("check/suppressed-no-reason", async (repo) => {
    await writeFile(path.join(repo, "design-gates.config.json"), '{"rules":{"SCH-001":{"severity":"off"}}}');
    assert.deepEqual(parse(await check(repo)).violations.map((v) => v.rule), ["SCH-002"]);
  });
});

test("agent output is byte-identical across runs and sorted", async () => {
  const sorted: RuleEntry = {
    ...quietRule("block"),
    id: "SCH-003",
    run: (c) => [
      { rule: "SCH-003", severity: "block", file: "", nodeId: "z", path: "z", message: "m", fix: { type: "replace", prop: "fill", value: "$a" }, theme: "mode=dark", affectedInstances: ["i"] },
      { rule: "SCH-003", severity: "block", file: "", nodeId: c.nodes[0]!.id, path: "p", message: "m" },
    ],
  };
  await withRepo("check/fail", async (repo) => {
    const a = await check(repo, {}, { entries: [...registry, sorted] });
    const b = await check(repo, {}, { entries: [...registry, sorted] });
    assert.equal(a.out, b.out);
    assert.equal(a.out.endsWith("\n"), true);
    assert.equal(a.out.trim().includes("\n"), false, "compact");
    const v = parse(a).violations;
    assert.deepEqual(v.map((x) => [x.nodeId, x.rule]), [["f", "SCH-003"], ["use", "SCH-002"], ["z", "SCH-003"]]);
    assert.deepEqual(Object.keys(v[0]!), ["rule", "severity", "file", "nodeId", "path", "message"]);
    assert.deepEqual(Object.keys(v[2]!), ["rule", "severity", "file", "nodeId", "path", "message", "fix", "affectedInstances", "theme"]);
  });
});

/** Minimal hand-written check of the SARIF 2.1.0 shape the format promises. */
function validateSarif(doc: any): void {
  assert.equal(doc.version, "2.1.0");
  assert.equal(typeof doc.$schema, "string");
  assert.equal(doc.runs.length, 1);
  const run = doc.runs[0];
  assert.equal(typeof run.tool.driver.name, "string");
  for (const rule of run.tool.driver.rules) assert.equal(typeof rule.id, "string");
  for (const res of run.results) {
    assert.equal(typeof res.ruleId, "string");
    assert.ok(["error", "warning", "note"].includes(res.level));
    assert.equal(typeof res.message.text, "string");
    assert.ok(res.locations.length > 0);
    for (const loc of res.locations) {
      assert.equal(typeof loc.physicalLocation.artifactLocation.uri, "string");
      assert.equal(typeof loc.logicalLocations[0].fullyQualifiedName, "string");
    }
  }
}

test("sarif output has the 2.1.0 shape", async () => {
  await withRepo("check/fail", async (repo) => {
    const r = await check(repo, { format: "sarif" }, { entries: [...registry.filter((r) => r.id !== "CMP-001"), quietRule("info")] });
    const doc = JSON.parse(r.out);
    validateSarif(doc);
    assert.deepEqual(doc.runs[0].tool.driver.rules.map((x: { id: string }) => x.id), ["A11Y-001", "CMP-001", "DIF-001", "RSP-001", "SCH-001", "SCH-002", "SCH-003", "STA-001", "TOK-001", "TOK-002"]);
    assert.deepEqual(doc.runs[0].results.map((x: { ruleId: string; level: string }) => [x.ruleId, x.level]), [["CMP-001", "note"], ["SCH-002", "error"]]);
    assert.equal(doc.runs[0].results[1].locations[0].physicalLocation.artifactLocation.uri, "bad.pen");
    assert.equal(doc.runs[0].results[1].locations[0].logicalLocations[0].fullyQualifiedName, "f/use");
    assert.equal(doc.runs[0].results[1].baselineState, undefined);
    await check(repo, { updateBaseline: true });
    const again = JSON.parse((await check(repo, { format: "sarif" })).out);
    validateSarif(again);
    assert.equal(again.runs[0].results[0].baselineState, "unchanged");
  });
});

test("text output has one line per violation plus a summary", async () => {
  await withRepo("check/fail", async (repo) => {
    const r = await check(repo, { format: "text" });
    assert.equal(r.out, 'bad.pen#f/use: block SCH-002 Instance refers to missing node "ghost"\n1 violation(s): 1 block, 0 warn, 0 review, 0 info (0 baselined)\n');
  });
  await withRepo("check/clean", async (repo) => {
    assert.equal((await check(repo, { format: "text" })).out, "No violations.\n");
  });
});

test("run from a subdirectory, paths resolve against it and `.` means all files", async () => {
  await withRepo("check/fail", async (repo) => {
    const whole = await check(repo);
    const sub = path.join(repo, "nested");
    const dot = await check(repo, { paths: ["."] }, { invokedFrom: repo });
    assert.equal(dot.code, whole.code);
    assert.equal(dot.out, whole.out);
    const outside = await check(repo, { paths: ["../.."] }, { invokedFrom: sub });
    assert.equal(outside.code, 2);
  });
});

test("real git: from a subdirectory the repo root holds config, baseline and the relative file", async () => {
  await withRepo("check/fail", async (repo) => {
    const sub = path.join(repo, "nested");
    await mkdir(sub);
    await writeFile(path.join(repo, "design-gates.config.json"), '{"rules":{"SCH-002":{"severity":"warn"}}}');
    const prev = process.cwd();
    process.chdir(sub);
    try {
      const run = async (options: CheckOptions): Promise<Result> => {
        let out = "";
        let err = "";
        const code = await runCheck(options, { ...defaultCheckDeps(), stdout: (t) => (out += t), stderr: (t) => (err += t) });
        return { code, out, err };
      };
      const r = await run({});
      assert.equal(r.code, 0, r.err);
      const [v] = parse(r).violations;
      assert.equal(v!.file, "bad.pen");
      assert.equal(v!.severity, "warn");
      const u = await run({ updateBaseline: true });
      assert.equal(u.code, 0, u.err);
      assert.match(await readFile(path.join(repo, "design-gates-baseline.json"), "utf8"), /"file": "bad.pen"/);
      await assert.rejects(readFile(path.join(sub, "design-gates-baseline.json"), "utf8"));
    } finally {
      process.chdir(prev);
    }
  });
});

test("--update-baseline replaces an invalid existing baseline", async () => {
  await withRepo("check/fail", async (repo) => {
    const file = path.join(repo, "design-gates-baseline.json");
    await writeFile(file, "[]");
    assert.equal((await check(repo, { updateBaseline: true })).code, 0);
    assert.deepEqual((JSON.parse(await readFile(file, "utf8")) as { version: number }).version, 1);
  });
});

test("a document too deep to diff under --base is reported as SCH-001, not exit 2", async () => {
  await withRepo("check/clean", async (repo) => {
    const n = 5000;
    const text = `{"version":"2.6","children":[${'{"id":"n","type":"frame","children":['.repeat(n)}{"id":"leaf","type":"frame"}${"]}".repeat(n)}]}`;
    await writeFile(path.join(repo, "deep.pen"), text);
    const r = await check(repo, { base: "base" });
    assert.notEqual(r.code, 2, r.err);
    assert.ok(parse(r).violations.some((v) => v.file === "deep.pen"));
  });
});
