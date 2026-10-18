import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultFs } from "../src/cli/run-diff.js";
import { runCheck, type CheckDeps } from "../src/cli/run-check.js";
import type { ContractReader } from "../src/contract/reader.js";
import { createGitReader } from "../src/git/exec.js";
import { createGitContractReader } from "../src/contract/reader.js";
import { DEFAULT_CONFIG } from "../src/index.js";
import { compile } from "../src/compile/compile.js";
import { runRules, type RuleEntry } from "../src/rules/index.js";
import type { ContractData } from "../src/contract/data.js";
import { createFixtureRepo } from "./helpers/fixture-repo.js";

// Mutations checked (each made the named test fail): loading without checking isRuleEnabled (off / narrowed
// entries call the reader); loading before checking needs (the plain run calls the reader); not turning
// ContractLoadError into a UsageError (exit 1/crash instead of 2); not passing `contract` through runRules;
// dropping the `listFiles([])` short-circuit in the git reader (covered in contract-loaders.test.ts).

let seen: (ContractData | undefined)[] = [];
const probe: RuleEntry = {
  id: "CNT-002",
  title: "probe",
  description: "records the contract it receives",
  defaultSeverity: "info",
  run: (_c, _cfg, _d, contract) => (seen.push(contract), []),
};

function counting(files: Record<string, string>): { reader: ContractReader; calls: string[] } {
  const calls: string[] = [];
  const miss = () => Object.assign(new Error("missing"), { code: "ENOENT" });
  return {
    calls,
    reader: {
      async readFile(p) {
        calls.push(`read:${p}`);
        if (!(p in files)) throw miss();
        return files[p]!;
      },
      async exists(p) {
        calls.push(`exists:${p}`);
        return p in files;
      },
      async listFiles(g) {
        calls.push(`list:${g.join()}`);
        return [];
      },
    },
  };
}

async function run(config: unknown, files: Record<string, string>, extra: Partial<CheckDeps> = {}): Promise<{ code: number; out: string; err: string; calls: string[] }> {
  const repo = await createFixtureRepo({ head: "check/clean" });
  try {
    await writeFile(path.join(repo.path, "design-gates.config.json"), JSON.stringify(config));
    const { reader, calls } = counting(files);
    let out = "";
    let err = "";
    const code = await runCheck({}, { cwd: repo.path, stdout: (t) => (out += t), stderr: (t) => (err += t), fs: defaultFs, entries: [probe], contractReader: reader, contractNeeds: { "CNT-002": { map: "required" } }, ...extra });
    return { code, out, err, calls };
  } finally {
    await repo.cleanup();
  }
}

test("a valid map reaches the rule as ContractData", async () => {
  seen = [];
  const r = await run({ rules: { "CNT-002": {} } }, { "pen-map.json": '{"a": "A.tsx"}' });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.calls, ["read:pen-map.json"]);
  assert.ok(seen.length > 0 && seen.every((c) => c?.mapFile === "pen-map.json" && c.map?.entries.get("a")?.path === "A.tsx"));
});

test("a malformed or missing required file is exit 2 naming the file", async () => {
  const bad = await run({ rules: { "CNT-002": {} } }, { "pen-map.json": "{oops" });
  assert.equal(bad.code, 2);
  assert.match(bad.err, /^design-gates: pen-map\.json: invalid JSON/);
  assert.equal(bad.out, "");
  const missing = await run({ contract: { mapFile: "docs/map.json" }, rules: { "CNT-002": {} } }, {});
  assert.equal(missing.code, 2);
  assert.match(missing.err, /^design-gates: docs\/map\.json: file not found\n$/);
});

test("an optional missing file is not an error and leaves the part out", async () => {
  seen = [];
  const r = await run({ rules: { "CNT-002": {} } }, {}, { contractNeeds: { "CNT-002": { map: "optional" } } });
  assert.equal(r.code, 0, r.err);
  assert.ok(seen.length > 0 && seen.every((c) => c !== undefined && c.map === undefined && c.mapFile === "pen-map.json"));
});

test("no rule needing a contract, or a needing rule that is not enabled, never calls the reader", async () => {
  const cases: [string, unknown, Partial<CheckDeps>][] = [
    ["empty CONTRACT_NEEDS", { rules: { "CNT-002": {} }, contract: { tokenSource: { kind: "css", path: "t.css" } } }, { contractNeeds: {} }],
    ["no config", null, {}],
    ["opt-in rule not configured", {}, {}],
    ["severity off", { rules: { "CNT-002": { severity: "off" } } }, {}],
    ["entries narrowed away", { rules: { "CNT-002": {} } }, { entries: [] }],
  ];
  for (const [name, config, extra] of cases) {
    seen = [];
    const r = await run(config, { "pen-map.json": "{oops", "t.css": "}" }, extra);
    assert.equal(r.code, 0, `${name}: ${r.err}`);
    assert.deepEqual(r.calls, [], name);
    assert.ok(seen.every((c) => c === undefined), name);
  }
});

test("the default CONTRACT_NEEDS is empty, so an ordinary run does no extra I/O", async () => {
  const repo = await createFixtureRepo({ head: "check/clean" });
  try {
    const { reader, calls } = counting({});
    let err = "";
    const code = await runCheck({}, { cwd: repo.path, stdout: () => undefined, stderr: (t) => (err += t), fs: defaultFs, contractReader: reader });
    assert.equal(code, 0, err);
    assert.deepEqual(calls, []);
  } finally {
    await repo.cleanup();
  }
});

test("runRules passes the contract to every rule and defaults to none", () => {
  const compiled = compile({ version: "2.6", children: [] }, { file: "a.pen" });
  const data: ContractData = { mapFile: "pen-map.json" };
  seen = [];
  runRules([{ file: "a.pen", compiled }], { ...DEFAULT_CONFIG, rules: { ...DEFAULT_CONFIG.rules, "CNT-002": { enabled: true } } }, [probe], data);
  assert.deepEqual(seen, [data]);
  assert.strictEqual(seen[0], data);
  seen = [];
  runRules([{ file: "a.pen", compiled }], { ...DEFAULT_CONFIG, rules: { ...DEFAULT_CONFIG.rules, "CNT-002": { enabled: true } } }, [probe]);
  assert.deepEqual(seen, [undefined]);
});

test("git-backed reader lists tracked and untracked non-ignored files, sorted, confined to the repo", async () => {
  const repo = await createFixtureRepo({ head: "check/clean" });
  try {
    await writeFile(path.join(repo.path, "z-new.txt"), "x");
    await writeFile(path.join(repo.path, "a-new.txt"), "x");
    await writeFile(path.join(repo.path, ".gitignore"), "ignored.txt\n");
    await writeFile(path.join(repo.path, "ignored.txt"), "x");
    const reader = createGitContractReader(createGitReader(repo.path));
    assert.deepEqual(await reader.listFiles(["*-new.txt", "a-new.txt", "ignored.txt"]), ["a-new.txt", "z-new.txt"]);
    assert.equal(await reader.readFile("a-new.txt"), "x");
    assert.equal(await reader.exists("a-new.txt"), true);
    assert.equal(await reader.exists("nope.txt"), false);
    await assert.rejects(reader.listFiles(["../x"]));
    await assert.rejects(reader.listFiles([":(top)x"]));
  } finally {
    await repo.cleanup();
  }
});
