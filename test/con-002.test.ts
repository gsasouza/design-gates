import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, runRules, type GatesConfig, type Violation } from "../src/index.js";
import type { ContractData, TokenValues } from "../src/contract/data.js";
import { CONTRACT_NEEDS, mergeNeeds } from "../src/contract/needs.js";
import { compileFixture } from "./helpers/gates.js";

// Mutations checked (each makes the named test fail): removing normalizeColor (#FFF vs #ffffff);
// dropping the px/numeric comparison (8 vs 8px); swapping block/warn (differ, missing); ignoring themes
// (dark theme, unmapped theme, fingerprint); looking unmapped themes up in the default table (unmapped theme);
// dropping the default-table fallback (themed fallback); dropping resolveCssVar (var() alias);
// skipping resolveAlias (alias); changing the nameTransform mapping (kebab/dtcg tests);
// dropping CON-002 from CONTRACT_NEEDS or loading without isRuleEnabled (needs / not enabled).

const config = (raw?: unknown): GatesConfig => {
  const r = resolveConfig(raw ?? { rules: { "CON-002": {} } });
  assert.ok("config" in r, JSON.stringify(r));
  return r.config;
};
const table = (o: Record<string, string>): TokenValues => new Map(Object.entries(o));
const tokens = (kind: "css" | "dtcg", byTheme: Record<string, Record<string, string>>): ContractData => ({
  mapFile: "pen-map.json",
  tokens: { kind, byTheme: new Map(Object.entries(byTheme).map(([k, v]) => [k, table(v)])) },
});
async function run(fixture: string, contract?: ContractData, raw?: unknown): Promise<Violation[]> {
  const file = `CON-002/${fixture}.pen`;
  const compiled = await compileFixture(file);
  return runRules([{ file, compiled }], config(raw), undefined, contract).filter((v) => v.rule === "CON-002");
}
const summary = (vs: Violation[]): string[] => vs.map((v) => `${v.nodeId}:${v.prop}:${v.severity}`);

const css = { "--color-bg": "#ffffff", "--space-md": "8px", "--font-family": "Inter", "--color-accent": "var(--color-bg)", "--color-surface": "#fff" };

test("equal values pass: #FFF vs #ffffff, 8 vs 8px, strings, aliases and var() references", async () => {
  assert.deepEqual(await run("equal.pass", tokens("css", { "": css })), []);
});

test("a number equals an unsuffixed code value, but not another unit", async () => {
  assert.deepEqual(await run("equal.pass", tokens("css", { "": { ...css, "--space-md": "8" } })), []);
  const out = await run("equal.pass", tokens("css", { "": { ...css, "--space-md": "8rem" } }));
  assert.deepEqual(summary(out), ["$var:space/md:value:block"]);
});

test("a differing value blocks, naming token, design and code value", async () => {
  const out = await run("differ.fail", tokens("css", { "": { "--color-bg": "#ffffff", "--space-md": "8px", "--color-same": "#FFFFFF" } }));
  assert.deepEqual(summary(out), ["$var:color.bg:value:block", "$var:space/md:value:block"]);
  assert.equal(out[0]!.message, 'Variable $color.bg is "#000" in design but code token --color-bg is "#ffffff"');
  assert.match(out[1]!.message, /is 12 in design but code token --space-md is "8px"/);
  assert.equal(out[0]!.path, "$var:color.bg");
  assert.equal(out[0]!.theme, undefined);
});

test("a variable without a code token warns", async () => {
  const out = await run("missing.fail", tokens("css", { "": { "--color-bg": "#fff" } }));
  assert.deepEqual(summary(out), ["$var:color.nope:value:warn"]);
  assert.match(out[0]!.message, /--color-nope/);
});

test("a resolved alias that differs is compared after resolution", async () => {
  const out = await run("equal.pass", tokens("css", { "": { ...css, "--color-surface": "#000000" } }));
  assert.deepEqual(summary(out), ["$var:color.surface:value:block"]);
});

test("an unresolved var() reference is compared as written", async () => {
  const out = await run("equal.pass", tokens("css", { "": { ...css, "--color-accent": "var(--nowhere)" } }));
  assert.deepEqual(summary(out), ["$var:color.accent:value:block"]);
  const fb = await run("equal.pass", tokens("css", { "": { ...css, "--color-accent": "var(--nowhere, #fff)" } }));
  assert.deepEqual(fb, []);
});

test("a dark theme value is compared against the mapped table", async () => {
  const dark = { "--color-bg": "#111111", "--color-card": "#333333", "--color-fg": "#EEE" };
  const base = { "--color-bg": "#fff", "--color-card": "#fff", "--color-fg": "#000" };
  const out = await run("themes.fail", tokens("css", { "": base, "mode=dark": dark }));
  assert.deepEqual(summary(out), ["$var:color.card:value[mode=dark]:block"]);
  assert.equal(out[0]!.theme, "mode=dark");
  assert.match(out[0]!.message, /#222.*#333333/);
});

test("an unmapped theme is skipped", async () => {
  // mode=light holds #abcdef in the design; with no light table it is never compared.
  const out = await run("themes.fail", tokens("css", { "": { "--color-bg": "#fff", "--color-card": "#fff", "--color-fg": "#000" } }));
  assert.deepEqual(out, []);
});

test("a token missing from a mapped theme falls back to the default table", async () => {
  const out = await run("themes.fail", tokens("css", { "": { "--color-bg": "#111", "--color-card": "#222", "--color-fg": "#eee" }, "mode=dark": {} }));
  assert.deepEqual(summary(out), ["$var:color.bg:value:block", "$var:color.card:value:block", "$var:color.fg:value:block"]);
});

test("a token missing from both tables warns for the theme value", async () => {
  const out = await run("themes.fail", tokens("css", { "": { "--color-bg": "#fff", "--color-fg": "#000" }, "mode=dark": { "--color-bg": "#111", "--color-fg": "#eee" } }));
  assert.deepEqual(summary(out), ["$var:color.card:value:warn", "$var:color.card:value[mode=dark]:warn"]);
});

test("fingerprints (rule, nodeId, prop) are unique across themes and sorted", async () => {
  const out = await run("themes.fail", tokens("css", { "": {}, "mode=dark": {} }));
  const keys = out.map((v) => `${v.rule}|${v.nodeId}|${v.prop}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(keys.length, 6);
  assert.deepEqual(keys, [...keys].sort());
});

test("dtcg-path transform looks variables up by dotted path", async () => {
  const dtcg = tokens("dtcg", { "": { "color.bg": "#ffffff", "space.md": "8", "font.family": "Inter", "color.accent": "#fff", "color.surface": "#ffffff" } });
  const raw = { rules: { "CON-002": { nameTransform: "dtcg-path" } } };
  assert.deepEqual(await run("equal.pass", dtcg, raw), []);
  // the default kebab-css transform finds none of these keys
  assert.equal((await run("equal.pass", dtcg)).length, 5);
  const bad = tokens("dtcg", { "": { "color.bg": "#000000", "space.md": "8", "font.family": "Inter", "color.accent": "#fff", "color.surface": "#ffffff" } });
  assert.deepEqual(summary(await run("equal.pass", bad, raw)), ["$var:color.bg:value:block"]);
});

test("nameTransform must be kebab-css or dtcg-path", () => {
  assert.ok(!("config" in resolveConfig({ rules: { "CON-002": { nameTransform: "snake" } } })));
  assert.equal(config().rules["CON-002"].nameTransform, "kebab-css");
});

test("without contract tokens nothing is reported", async () => {
  assert.deepEqual(await run("differ.fail"), []);
  assert.deepEqual(await run("differ.fail", { mapFile: "pen-map.json" }), []);
});

test("CON-002 needs the token source (required)", () => {
  assert.deepEqual(CONTRACT_NEEDS["CON-002"], { tokens: "required" });
  assert.deepEqual(mergeNeeds(["CON-001", "CON-002"]), { map: "required", tokens: "required" });
});
