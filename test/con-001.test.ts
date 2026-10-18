import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, runRules, type GatesConfig, type Violation } from "../src/index.js";
import type { ContractData } from "../src/contract/data.js";
import { loadContract } from "../src/contract/load.js";
import { CONTRACT_NEEDS, mergeNeeds } from "../src/contract/needs.js";
import { parsePenMap, type PenMap } from "../src/contract/pen-map.js";
import type { ContractReader } from "../src/contract/reader.js";
import { compileFixture } from "./helpers/gates.js";

// Mutations checked (each makes the named test fail): dropping the designOnly check (designOnly silent);
// dropping the missingPaths check (missing path); dropping the requireFor filter (requireFor filters);
// dropping `node.expanded`/`instanceOf` skips or the reusable check (instances never reported);
// looking up by node.id instead of node.sourceId (duplicate ids); dropping `if (!map) return []` (no map);
// dropping CON-001 from CONTRACT_NEEDS or loading without isRuleEnabled (not enabled / reader tests).

const config = (raw?: unknown): GatesConfig => {
  const r = resolveConfig(raw ?? { rules: { "CON-001": {} } });
  assert.ok("config" in r, JSON.stringify(r));
  return r.config;
};
const map = (entries: Record<string, unknown>, missing: string[] = []): ContractData => {
  const m: PenMap = parsePenMap(JSON.stringify(entries), "pen-map.json");
  m.missingPaths = new Set(missing);
  return { mapFile: "pen-map.json", map: m };
};
async function run(fixture: string, contract?: ContractData, raw?: unknown): Promise<Violation[]> {
  const file = `CON-001/${fixture}.pen`;
  const compiled = await compileFixture(file);
  return runRules([{ file, compiled }], config(raw), undefined, contract).filter((v) => v.rule === "CON-001");
}
const summary = (vs: Violation[]): string[] => vs.map((v) => `${v.nodeId}:${v.prop ?? ""}:${v.severity}`);

test("unmapped components warn, naming the component; mapped ones do not", async () => {
  const out = await run("components.fail", map({ btn: "src/Button.tsx" }, []));
  assert.deepEqual(summary(out), ["card::warn", "icon::warn", "tag::warn"]);
  assert.equal(out[0]!.message, 'Component "Card" has no entry in pen-map.json');
});

test("designOnly entries are silent", async () => {
  const out = await run("components.fail", map({ btn: "a.tsx", card: { designOnly: true }, icon: { designOnly: true }, tag: "b.tsx" }));
  assert.deepEqual(out, []);
});

test("a mapped path that does not exist warns on prop path, naming the path", async () => {
  const out = await run("components.fail", map({ btn: "src/Gone.tsx", card: "ok.tsx", icon: "ok.tsx", tag: "ok.tsx" }, ["src/Gone.tsx"]));
  assert.deepEqual(summary(out), ["btn:path:warn"]);
  assert.equal(out[0]!.message, 'Component "Button" maps to "src/Gone.tsx", which does not exist');
});

test("unmapped and missing-path findings are sorted by nodeId then prop", async () => {
  const out = await run("components.fail", map({ btn: "gone.tsx", tag: "gone.tsx" }, ["gone.tsx"]));
  assert.deepEqual(summary(out), ["btn:path:warn", "card::warn", "icon::warn", "tag:path:warn"]);
});

test("requireFor keeps only components whose name matches a glob", async () => {
  const raw = { rules: { "CON-001": { requireFor: ["Ca*", "Tag"] } } };
  assert.deepEqual(summary(await run("components.fail", map({}), raw)), ["card::warn", "tag::warn"]);
});

test("instances, expanded copies and plain frames are never reported", async () => {
  assert.deepEqual(await run("mapped.pass", map({ btn: "src/Button.tsx" })), []);
  const out = await run("mapped.pass", map({}));
  assert.deepEqual(summary(out), ["btn::warn"]);
});

test("a duplicate-id component is reported once per compiled node, looked up by source id", async () => {
  const out = await run("dup.fail", map({}));
  assert.equal(out.length, 2);
  assert.equal(new Set(out.map((v) => v.nodeId)).size, 2);
  assert.ok(out.some((v) => v.nodeId.includes("~")));
  assert.deepEqual(await run("dup.fail", map({ btn: "x.tsx" })), []);
  assert.equal((await run("dup.fail", map({ btn: "x.tsx" }, ["x.tsx"]))).length, 2);
});

test("without a map nothing is reported", async () => {
  assert.deepEqual(await run("components.fail", undefined), []);
  assert.deepEqual(await run("components.fail", { mapFile: "pen-map.json" }), []);
});

test("not enabled: no findings", async () => {
  assert.deepEqual(await run("components.fail", map({}), {}), []);
});

function counting(files: Record<string, string>): { reader: ContractReader; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    reader: {
      async readFile(p) {
        calls.push(`read:${p}`);
        if (!(p in files)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return files[p]!;
      },
      async exists(p) {
        calls.push(`exists:${p}`);
        return p in files;
      },
      async listFiles() {
        return [];
      },
    },
  };
}

test("CON-001 needs the map (required); other rules need nothing", () => {
  assert.deepEqual(CONTRACT_NEEDS["CON-001"], { map: "required" });
  assert.deepEqual(mergeNeeds(["SCH-001"]), {});
});

test("the loader precomputes missing paths through reader.exists", async () => {
  const { reader, calls } = counting({ "pen-map.json": '{"a":"src/a.tsx","b":"src/gone.tsx","c":{"designOnly":true},"d":"src/a.tsx"}', "src/a.tsx": "" });
  const data = await loadContract(config(), { map: "required" }, reader);
  assert.deepEqual([...data!.map!.missingPaths!], ["src/gone.tsx"]);
  assert.deepEqual(calls, ["read:pen-map.json", "exists:src/a.tsx", "exists:src/gone.tsx"]);
});

test("a missing map file is a load error", async () => {
  const { reader } = counting({});
  await assert.rejects(loadContract(config(), { map: "required" }, reader), /pen-map\.json/);
});
