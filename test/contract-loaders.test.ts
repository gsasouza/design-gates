import { test } from "node:test";
import assert from "node:assert/strict";
import { readCssCustomProperties } from "../src/contract/css.js";
import { readDtcg } from "../src/contract/dtcg.js";
import { ContractLoadError } from "../src/contract/errors.js";
import { loadContract } from "../src/contract/load.js";
import { parsePenMap } from "../src/contract/pen-map.js";
import { createGitContractReader, type ContractReader } from "../src/contract/reader.js";
import { resolveConfig, type GatesConfig } from "../src/index.js";

// Mutations checked (each made the named test fail): pen-map: skipping the designOnly/path rule, the `..` check,
// or the JSON error wrapping; css: removing the selector filter (only configured selectors), not stripping comments,
// descending into at-rule blocks, not erroring on a missing `}`; dtcg: not inheriting $type, not resolving aliases,
// dropping cycle detection, ignoring `hex`, ignoring alpha, dropping the dimension branch; load: ignoring `need`.

const throwsLoad = (fn: () => unknown, file: string, pattern: RegExp): void =>
  assert.throws(fn, (e: unknown) => e instanceof ContractLoadError && e.file === file && e.message.startsWith(`${file}: `) && pattern.test(e.message));

test("pen-map: string, object and designOnly entries with lines", () => {
  const map = parsePenMap('{\n  "a": "src/A.tsx",\n  "b": { "path": "src/B.tsx" },\n  "c": { "designOnly": true }\n}', "pen-map.json");
  assert.deepEqual([...map.entries], [
    ["a", { path: "src/A.tsx", line: 2 }],
    ["b", { path: "src/B.tsx", line: 3 }],
    ["c", { designOnly: true, line: 4 }],
  ]);
  assert.equal(map.file, "pen-map.json");
});

test("pen-map: malformed input is a load error naming file and component", () => {
  throwsLoad(() => parsePenMap("{nope", "pen-map.json"), "pen-map.json", /invalid JSON/);
  throwsLoad(() => parsePenMap("[]", "pen-map.json"), "pen-map.json", /JSON object/);
  throwsLoad(() => parsePenMap('{"a": 1}', "pen-map.json"), "pen-map.json", /component "a"/);
  throwsLoad(() => parsePenMap('{"a": {}}', "pen-map.json"), "pen-map.json", /component "a".*needs a "path"/);
  throwsLoad(() => parsePenMap('{"a": {"designOnly": false}}', "pen-map.json"), "pen-map.json", /component "a".*designOnly/);
  throwsLoad(() => parsePenMap('{"a": {"path": "x", "extra": 1}}', "pen-map.json"), "pen-map.json", /unknown key "extra"/);
  throwsLoad(() => parsePenMap('{"a": ""}', "pen-map.json"), "pen-map.json", /component "a"/);
  throwsLoad(() => parsePenMap('{"btn": "/etc/passwd"}', "pen-map.json"), "pen-map.json", /component "btn"/);
  throwsLoad(() => parsePenMap('{"btn": "../x.tsx"}', "pen-map.json"), "pen-map.json", /component "btn"/);
  throwsLoad(() => parsePenMap('{"btn": {"path": "a/../../x"}}', "pen-map.json"), "pen-map.json", /component "btn"/);
});

const CSS = `
/* :root { --ghost: 1; } */
:root { --bg: #fff; --fg:  #111 ; color: red; --bg: #fafafa; }
.other { --nope: 1; }
[data-theme=dark], .x { --bg: #000; --fg: #eee }
@media (prefers-color-scheme: dark) { :root { --media: 1; } }
@layer base { :root { --layer: 1; } }
:root { & .child { --nested: 1; } --after: "a;b}"; }
`;

test("css: reads only configured selectors, ignoring comments, other properties, at-rules and nested rules", () => {
  const r = readCssCustomProperties(CSS, [":root", "[data-theme=dark]"], "t.css");
  assert.deepEqual([...r.get(":root")!], [["--bg", "#fafafa"], ["--fg", "#111"], ["--after", '"a;b}"']]);
  assert.deepEqual([...r.get("[data-theme=dark]")!], [["--bg", "#000"], ["--fg", "#eee"]]);
  assert.deepEqual([...readCssCustomProperties(CSS, [".other"], "t.css").get(".other")!], [["--nope", "1"]]);
  assert.equal(readCssCustomProperties(CSS, [".absent"], "t.css").get(".absent")!.size, 0);
});

test("css: malformed input is a load error", () => {
  throwsLoad(() => readCssCustomProperties(":root { --a: 1;", [":root"], "t.css"), "t.css", /unbalanced/);
  throwsLoad(() => readCssCustomProperties(":root { --a: 1; } }", [":root"], "t.css"), "t.css", /unbalanced/);
  throwsLoad(() => readCssCustomProperties(":root { --a: 1; } /* open", [":root"], "t.css"), "t.css", /comment/);
  throwsLoad(() => readCssCustomProperties(':root { --a: "x; }', [":root"], "t.css"), "t.css", /string/);
  throwsLoad(() => readCssCustomProperties(":root { --a: 1; } junk", [":root"], "t.css"), "t.css", /unexpected/);
});

test("dtcg: inherited $type, nested groups, aliases, colours and dimensions", () => {
  const json = {
    $type: "color",
    color: {
      bg: { $value: { colorSpace: "srgb", components: [1, 1, 1], hex: "#FFFFFF" } },
      scrim: { $value: { colorSpace: "srgb", components: [0, 0, 0], alpha: 0.5 } },
      half: { $value: { colorSpace: "srgb", components: [0, 0, 0], hex: "#000", alpha: 0.5 } },
      str: { $value: "#abcdef" },
      main: { $value: "{color.bg}" },
      deep: { $value: "{color.main}" },
    },
    size: { $type: "dimension", pad: { $value: { value: 16, unit: "px" } }, same: { $value: "{size.pad}" } },
    num: { $type: "number", n: { $value: 2 } },
  };
  const r = readDtcg(JSON.stringify(json), "t.json");
  assert.deepEqual(Object.fromEntries(r), {
    "color.bg": "#ffffff",
    "color.scrim": "#00000080",
    "color.half": "#00000080",
    "color.str": "#abcdef",
    "color.main": "#ffffff",
    "color.deep": "#ffffff",
    "size.pad": "16px",
    "size.same": "16px",
    "num.n": "2",
  });
});

test("dtcg: type is inherited from the nearest group and overridden nearer", () => {
  const colour = { colorSpace: "srgb", components: [1, 0, 0] };
  assert.equal(readDtcg(JSON.stringify({ $type: "dimension", g: { $type: "color", c: { $value: colour } } }), "t.json").get("g.c"), "#ff0000");
  // a bare number is only valid for a non-dimension type: the group's dimension type applies to the child
  throwsLoad(() => readDtcg(JSON.stringify({ g: { $type: "dimension", n: { $value: 4 } } }), "t.json"), "t.json", /token g\.n.*dimension/);
  throwsLoad(() => readDtcg(JSON.stringify({ $type: "dimension", g: { n: { $value: 4 } } }), "t.json"), "t.json", /token g\.n.*dimension/);
  assert.equal(readDtcg(JSON.stringify({ g: { $type: "dimension", n: { $type: "number", $value: 4 } } }), "t.json").get("g.n"), "4");
});

test("dtcg: errors are load errors", () => {
  throwsLoad(() => readDtcg("{", "t.json"), "t.json", /invalid JSON/);
  throwsLoad(() => readDtcg('{"a": {"$value": "{b}"}, "b": {"$value": "{a}"}}', "t.json"), "t.json", /alias cycle/);
  throwsLoad(() => readDtcg('{"a": {"$value": "{a}"}}', "t.json"), "t.json", /alias cycle/);
  throwsLoad(() => readDtcg('{"a": {"$value": "{nope}"}}', "t.json"), "t.json", /alias \{nope\} has no target/);
  throwsLoad(() => readDtcg('{"g": {"x": {"$value": 1}}, "a": {"$value": "{g}"}}', "t.json"), "t.json", /no target/);
  throwsLoad(() => readDtcg('{"a": {"$type": "color", "$value": {"colorSpace": "display-p3", "components": [1, 0, 0]}}}', "t.json"), "t.json", /token a: colour space "display-p3"/);
  throwsLoad(() => readDtcg('{"a": {"$type": "color", "$value": {"colorSpace": "srgb", "components": [2, 0, 0]}}}', "t.json"), "t.json", /token a/);
  throwsLoad(() => readDtcg('{"a": {"$type": "color", "$value": {"hex": "red", "colorSpace": "srgb", "components": [0, 0, 0]}}}', "t.json"), "t.json", /token a.*hex/);
  throwsLoad(() => readDtcg('{"a": {"$type": "dimension", "$value": {"value": "x", "unit": "px"}}}', "t.json"), "t.json", /token a.*dimension/);
  throwsLoad(() => readDtcg('{"a": {"$type": "dimension", "$value": 4}}', "t.json"), "t.json", /token a.*dimension/);
  throwsLoad(() => readDtcg('{"a": 3}', "t.json"), "t.json", /neither a token nor a group/);
});

function fakeReader(files: Record<string, string>, calls: string[] = []): ContractReader {
  return {
    async readFile(p) {
      calls.push(`read:${p}`);
      if (!(p in files)) throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      return files[p]!;
    },
    async exists(p) {
      calls.push(`exists:${p}`);
      return p in files;
    },
    async listFiles(globs) {
      calls.push(`list:${globs.join(",")}`);
      return Object.keys(files).sort();
    },
  };
}

const cfg = (contract?: unknown): GatesConfig => {
  const r = resolveConfig(contract === undefined ? {} : { contract });
  assert.ok("config" in r);
  return r.config;
};

test("loadContract: nothing needed means no reader call", async () => {
  const calls: string[] = [];
  assert.equal(await loadContract(cfg({ tokenSource: { kind: "css", path: "t.css" } }), {}, fakeReader({}, calls)), undefined);
  assert.deepEqual(calls, []);
});

test("loadContract: map and css tokens by theme", async () => {
  const files = { "pen-map.json": '{"a": "A.tsx"}', "t.css": ":root{--a:1} [data-theme=dark]{--a:2} .free{--z:9}" };
  const data = await loadContract(cfg({ tokenSource: { kind: "css", path: "t.css", themes: { "mode=dark": "[data-theme=dark]" } } }), { map: "required", tokens: "required" }, fakeReader(files));
  assert.ok(data);
  assert.equal(data.mapFile, "pen-map.json");
  assert.deepEqual([...data.map!.entries.keys()], ["a"]);
  assert.equal(data.tokens!.kind, "css");
  assert.deepEqual([...data.tokens!.byTheme].map(([k, v]) => [k, [...v]]), [["", [["--a", "1"]]], ["mode=dark", [["--a", "2"]]]]);
});

test("loadContract: dtcg tokens by theme", async () => {
  const files = { "t.json": '{"a": {"$value": "1px", "$type": "dimension"}}', "d.json": '{"a": {"$value": "2px"}}' };
  const data = await loadContract(cfg({ tokenSource: { kind: "dtcg", path: "t.json", themes: { "mode=dark": "d.json" } } }), { tokens: "required" }, fakeReader(files));
  assert.deepEqual([...data!.tokens!.byTheme].map(([k, v]) => [k, [...v]]), [["", [["a", "1px"]]], ["mode=dark", [["a", "2px"]]]]);
});

test("loadContract: required vs optional missing files, and malformed files", async () => {
  const tokens = cfg({ tokenSource: { kind: "css", path: "t.css" } });
  await assert.rejects(loadContract(cfg(), { map: "required" }, fakeReader({})), (e) => e instanceof ContractLoadError && e.message === "pen-map.json: file not found");
  const optional = await loadContract(cfg(), { map: "optional" }, fakeReader({}));
  assert.deepEqual(optional, { mapFile: "pen-map.json" });
  await assert.rejects(loadContract(tokens, { tokens: "required" }, fakeReader({})), (e) => e instanceof ContractLoadError && e.file === "t.css");
  assert.deepEqual(await loadContract(tokens, { tokens: "optional" }, fakeReader({})), { mapFile: "pen-map.json" });
  await assert.rejects(loadContract(cfg(), { tokens: "required" }, fakeReader({})), (e) => e instanceof ContractLoadError && /contract\.tokenSource/.test(e.message));
  assert.deepEqual(await loadContract(cfg(), { tokens: "optional" }, fakeReader({})), { mapFile: "pen-map.json" });
  await assert.rejects(loadContract(cfg({ mapFile: "m.json" }), { map: "optional" }, fakeReader({ "m.json": "{" })), (e) => e instanceof ContractLoadError && e.file === "m.json");
  const broken: ContractReader = { ...fakeReader({}), readFile: async () => { throw new Error("boom"); } };
  await assert.rejects(loadContract(cfg(), { map: "optional" }, broken), (e) => e instanceof ContractLoadError && /pen-map\.json: cannot read: boom/.test(e.message));
});

test("git contract reader: listFiles([]) never calls git; exists maps ENOENT to false", async () => {
  const calls: string[] = [];
  const git = {
    listFiles: async (g: string[]) => (calls.push(`list:${g.join()}`), ["b", "a"]),
    readWorktree: async (p: string) => {
      if (p === "gone") throw Object.assign(new Error("x"), { code: "ENOENT" });
      if (p === "bad") throw Object.assign(new Error("x"), { code: "EACCES" });
      return "text";
    },
  } as never;
  const r = createGitContractReader(git);
  assert.deepEqual(await r.listFiles([]), []);
  assert.deepEqual(calls, []);
  assert.deepEqual(await r.listFiles(["src/**"]), ["b", "a"]);
  assert.equal(await r.exists("ok"), true);
  assert.equal(await r.exists("gone"), false);
  await assert.rejects(r.exists("bad"));
});
