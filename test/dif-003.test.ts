import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compile, DEFAULT_CONFIG, parsePen, registry, resolveConfig, type CompiledDocument, type GatesConfig, type Violation } from "../src/index.js";
import type { ContractData } from "../src/contract/data.js";
import { CONTRACT_NEEDS, mergeNeeds } from "../src/contract/needs.js";
import { loadContract } from "../src/contract/load.js";
import { ContractLoadError } from "../src/contract/errors.js";
import type { ContractReader } from "../src/contract/reader.js";
import { parsePenMap } from "../src/contract/pen-map.js";
import { runCheck } from "../src/cli/run-check.js";
import { defaultFs } from "../src/cli/run-diff.js";
import { createFixtureRepo } from "./helpers/fixture-repo.js";
import { gateFixture } from "./helpers/gates.js";

// Mutations checked (each makes the named test fail): dropping the removed-in-diff check (kept node,
// unreferenced node); dropping marker scanning (marker, both); dropping the map lookup (map, both);
// dropping the added-id filter (moved node); not requiring a base (no base); escaping the pattern wrongly
// or accepting regex (custom pattern); not trimming the trailing dot or dropping `:` from the id class
// (id token); skipping the NUL/size checks (skipped files); dropping the file cap (too many files);
// making the map required for DIF-003 (optional map); loading without isRuleEnabled or without the
// --base guard (not enabled / no base).

const rule = registry.find((r) => r.id === "DIF-003")!;
const config = (raw: unknown = {}): GatesConfig => {
  const r = resolveConfig({ rules: { "DIF-003": raw } });
  assert.ok("config" in r, JSON.stringify(r));
  return r.config;
};
const load = async (name: string): Promise<CompiledDocument> => compile(parsePen(await readFile(gateFixture(`DIF-003/${name}.pen`), "utf8")), { file: `DIF-003/${name}.pen` });
const pair = async (c: string): Promise<[CompiledDocument, CompiledDocument]> => [await load(`${c}.base`), await load(`${c}.head`)];
const contract = (o: { map?: string[]; markers?: Record<string, [string, number][]> } = {}): ContractData => ({
  mapFile: "pen-map.json",
  ...(o.map && { map: parsePenMap(JSON.stringify(Object.fromEntries(o.map.map((id) => [id, "src/X.tsx"]))), "pen-map.json") }),
  ...(o.markers && { markers: new Map(Object.entries(o.markers).map(([id, refs]) => [id, refs.map(([file, line]) => ({ file, line }))])) }),
});
const run = (base: CompiledDocument | undefined, head: CompiledDocument, c: ContractData | undefined, cfg = config()): Violation[] =>
  rule.run(head, cfg, { ...(base && { base }), head }, c);

test("DIF-003 is a registered opt-in block rule with a default marker pattern", () => {
  assert.equal(rule.defaultSeverity, "block");
  assert.equal(DEFAULT_CONFIG.rules["DIF-003"].enabled, false);
  assert.equal(DEFAULT_CONFIG.rules["DIF-003"].markerPattern, "@pen:<id>");
  assert.equal(config().rules["DIF-003"].enabled, true);
  assert.deepEqual(CONTRACT_NEEDS["DIF-003"], { map: "optional", markers: "optional" });
});

test("a removed node in the pen map blocks, once, on the base path", async () => {
  const [b, h] = await pair("removed.fail");
  const out = run(b, h, contract({ map: ["btn-old"] }));
  assert.equal(out.length, 1);
  const v = out[0]!;
  assert.deepEqual([v.rule, v.severity, v.nodeId, v.prop, v.file, v.path], ["DIF-003", "block", "btn-old", undefined, "DIF-003/removed.fail.head.pen", b.nodes.find((n) => n.sourceId === "btn-old")!.path]);
  assert.match(v.message, /"btn-old".* pen-map\.json$/);
});

test("a removed node with a marker blocks with file:line", async () => {
  const [b, h] = await pair("removed.fail");
  const out = run(b, h, contract({ markers: { "btn-old": [["src/b.tsx", 7], ["src/a.tsx", 12]] } }));
  assert.equal(out.length, 1);
  assert.match(out[0]!.message, /by src\/a\.tsx:12, src\/b\.tsx:7$/);
});

test("map and markers give one finding listing both, map first", async () => {
  const [b, h] = await pair("removed.fail");
  const out = run(b, h, contract({ map: ["btn-old"], markers: { "btn-old": [["src/a.tsx", 3]] } }));
  assert.equal(out.length, 1);
  assert.match(out[0]!.message, /by pen-map\.json, src\/a\.tsx:3$/);
});

test("findings are sorted by node id", async () => {
  const [b, h] = await pair("removed.fail");
  const out = run(b, h, contract({ map: ["btn-primary", "btn-old"] }));
  assert.deepEqual(out.map((v) => v.nodeId), ["btn-old", "btn-primary"]);
});

test("a removed but unreferenced node is silent", async () => {
  const [b, h] = await pair("removed.fail");
  assert.deepEqual(run(b, h, contract({ map: ["other"], markers: { other: [["a.ts", 1]] } })), []);
});

test("a referenced node that is not removed is silent", async () => {
  const [b, h] = await pair("removed.pass");
  assert.deepEqual(run(b, h, contract({ map: ["btn-primary", "title"], markers: { "btn-primary": [["a.ts", 1]] } })), []);
});

test("a node moved between frames is not removed", () => {
  const doc = (a: string[], b: string[]): CompiledDocument =>
    compile(parsePen(JSON.stringify({ version: "2.6", children: [{ id: "f1", type: "frame", name: "One", children: a.map((id) => ({ id, type: "text", content: id })) }, { id: "f2", type: "frame", name: "Two", children: b.map((id) => ({ id, type: "text", content: id })) }] })), { file: "m.pen" });
  assert.deepEqual(run(doc(["m", "k1"], ["k2"]), doc(["k1"], ["k2", "m"]), contract({ map: ["m"] })), []);
});

test("without a base, a contract or any input the rule is silent", async () => {
  const [b, h] = await pair("removed.fail");
  assert.deepEqual(run(undefined, h, contract({ map: ["btn-old"] })), []);
  assert.deepEqual(rule.run(h, config(), undefined, contract({ map: ["btn-old"] })), []);
  assert.deepEqual(run(b, h, undefined), []);
  assert.deepEqual(run(b, h, contract()), []);
});

test("markers alone work when the optional map is missing", async () => {
  const [b, h] = await pair("removed.fail");
  assert.equal(run(b, h, contract({ markers: { "btn-old": [["a.ts", 1]] } })).length, 1);
});

test("an invalid markerPattern is a config error", () => {
  for (const bad of ["@pen:", "<id> <id>", 5, ""]) {
    const r = resolveConfig({ rules: { "DIF-003": { markerPattern: bad } } });
    assert.ok(!("config" in r), String(bad));
  }
  assert.equal(config({ markerPattern: "REF[<id>]" }).rules["DIF-003"].markerPattern, "REF[<id>]");
});

// ---- marker loader

function memory(files: Record<string, string>): ContractReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async readFile(p) {
      calls.push(`read:${p}`);
      if (!(p in files)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return files[p]!;
    },
    async exists(p) {
      calls.push(`exists:${p}`);
      return p in files;
    },
    async listFiles(g) {
      calls.push(`list:${g.join()}`);
      return Object.keys(files).filter((f) => f !== "pen-map.json").sort();
    },
  };
}
const withGlobs = (cfg: GatesConfig, codeGlobs: string[]): GatesConfig => ({ ...cfg, contract: { mapFile: "pen-map.json", codeGlobs } });
const markers = async (files: Record<string, string>, raw: unknown = {}, globs = ["src/**"]): Promise<Record<string, string[]>> => {
  const data = await loadContract(withGlobs(config(raw), globs), { markers: "optional" }, memory(files));
  return Object.fromEntries([...data!.markers!].map(([id, refs]) => [id, refs.map((r) => `${r.file}:${r.line}`)]));
};

test("markers are scanned per line, with the id token rules", async () => {
  const out = await markers({
    "src/a.ts": "x\n// @pen:btn-primary.\nconst y = '@pen:1:2' + \"@pen:a_b~c.d\" // @pen:two @pen:three\r\n// @pen:\n",
  });
  assert.deepEqual(out, { "btn-primary": ["src/a.ts:2"], "1:2": ["src/a.ts:3"], "a_b~c.d": ["src/a.ts:3"], two: ["src/a.ts:3"], three: ["src/a.ts:3"] });
});

test("the id never spans a slash or whitespace", async () => {
  assert.deepEqual(await markers({ "src/a.ts": "@pen:a/b\n@pen:c d\n" }), { a: ["src/a.ts:1"], c: ["src/a.ts:2"] });
});

test("a custom markerPattern is matched literally, with no regex", async () => {
  const files = { "src/a.ts": "REF[btn] ref(x) REF(a.b) <!-- pen=card -->\n" };
  assert.deepEqual(await markers(files, { markerPattern: "REF[<id>]" }), { btn: ["src/a.ts:1"] });
  assert.deepEqual(await markers(files, { markerPattern: "REF(<id>)" }), { "a.b": ["src/a.ts:1"] });
  assert.deepEqual(await markers(files, { markerPattern: "<!-- pen=<id> -->" }), { card: ["src/a.ts:1"] });
  assert.deepEqual(await markers({ "src/a.ts": "aXb" }, { markerPattern: "a.<id>" }), {});
});

test("binary, oversized and unreadable files are skipped; empty codeGlobs means no markers", async () => {
  const reader = memory({
    "src/ok.ts": "@pen:a\n",
    "src/bin.dat": "@pen:b\0\n",
    "src/big.ts": "@pen:c\n" + "x".repeat(1024 * 1024),
    "src/late-nul.ts": "@pen:d\n" + "x".repeat(9000) + "\0",
  });
  const readFile = reader.readFile;
  reader.readFile = async (p) => (p === "src/gone.ts" ? Promise.reject(new Error("EACCES")) : readFile(p));
  const listFiles = reader.listFiles;
  reader.listFiles = async (g) => [...(await listFiles(g)), "src/gone.ts"];
  const data = await loadContract(withGlobs(config(), ["src/**"]), { markers: "optional" }, reader);
  assert.deepEqual([...data!.markers!.keys()].sort(), ["a", "d"]);
  const none = memory({ "src/ok.ts": "@pen:a\n" });
  assert.equal((await loadContract(withGlobs(config(), []), { markers: "optional" }, none))!.markers!.size, 0);
  assert.deepEqual(none.calls, []);
});

test("more than 10 000 matched files is a load error naming contract.codeGlobs", async () => {
  const reader = memory({});
  reader.listFiles = async () => Array.from({ length: 10_001 }, (_, i) => `src/${i}.ts`);
  await assert.rejects(loadContract(withGlobs(config(), ["src/**"]), { markers: "optional" }, reader), (e: unknown) => e instanceof ContractLoadError && /^contract\.codeGlobs: /.test(e.message));
  reader.listFiles = async () => Array.from({ length: 10_000 }, (_, i) => `src/${i}.ts`);
  reader.readFile = async () => "";
  assert.equal((await loadContract(withGlobs(config(), ["src/**"]), { markers: "optional" }, reader))!.markers!.size, 0);
});

test("the map is optional for DIF-003 alone but required once CON-001 is enabled", async () => {
  assert.deepEqual(mergeNeeds(["DIF-003"]), { map: "optional", markers: "optional" });
  assert.deepEqual(mergeNeeds(["CON-001", "DIF-003"]), { map: "required", markers: "optional" });
  const cfg = withGlobs(config(), []);
  const data = await loadContract(cfg, mergeNeeds(["DIF-003"]), memory({}));
  assert.equal(data!.map, undefined);
  await assert.rejects(loadContract(cfg, mergeNeeds(["CON-001", "DIF-003"]), memory({})), /pen-map\.json: file not found/);
});

// ---- check CLI

async function check(cfg: unknown, files: Record<string, string>, base?: string, repoOpts = {}): Promise<{ code: number; out: string; err: string; calls: string[] }> {
  const repo = await createFixtureRepo(repoOpts);
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(`${repo.path}/design-gates.config.json`, JSON.stringify(cfg));
    const reader = memory(files);
    let out = "";
    let err = "";
    const code = await runCheck({ ...(base && { base }) }, { cwd: repo.path, stdout: (t) => (out += t), stderr: (t) => (err += t), fs: defaultFs, contractReader: reader });
    return { code, out, err, calls: reader.calls };
  } finally {
    await repo.cleanup();
  }
}
const cliConfig = { contract: { codeGlobs: ["src/**"] }, rules: { "DIF-003": {} } };

test("check --base blocks a removed node still marked in code", async () => {
  const r = await check(cliConfig, { "src/a.tsx": "x\n// @pen:gone-rect\n" }, "base");
  assert.equal(r.code, 1, r.err);
  assert.match(r.out, /DIF-003/);
  assert.match(r.out, /src\/a\.tsx:2/);
});

test("check without --base reads and lists nothing for DIF-003", async () => {
  const r = await check(cliConfig, { "src/a.tsx": "// @pen:gone-rect\n", "pen-map.json": "{oops" }, undefined, { head: "check/clean" });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.calls, []);
});

test("DIF-003 not enabled lists and reads nothing, even with --base", async () => {
  for (const cfg of [{ contract: cliConfig.contract }, { contract: cliConfig.contract, rules: { "DIF-003": { severity: "off" } } }]) {
    const r = await check(cfg, { "src/a.tsx": "// @pen:gone-rect\n", "pen-map.json": "{oops" }, "base", { head: "check/clean" });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.calls, []);
  }
});

test("known gap: a design file deleted since the base is not checked by DIF-003", async () => {
  const r = await check({ rules: { "DIF-003": {} } }, { "pen-map.json": '{"file-removed-frame": "src/X.tsx"}' }, "base");
  assert.equal(r.err, "");
  assert.doesNotMatch(r.out, /DIF-003|file-removed-frame/);
});
