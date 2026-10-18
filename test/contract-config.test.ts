import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, resolveConfig } from "../src/index.js";

// Mutations checked (each made a test below fail): dropping "contract" from the allowed top-level keys;
// not applying the defaults; removing the path check (absolute / ..); removing the theme-key canonical check;
// dropping the codeGlobs ":" check; allowing selectors for dtcg.

const err = (contract: unknown): string => {
  const r = resolveConfig({ contract });
  assert.ok("error" in r, JSON.stringify(contract));
  return r.error;
};

test("no contract key: config is unchanged", () => {
  const r = resolveConfig({});
  assert.deepEqual(r, { config: DEFAULT_CONFIG });
  assert.ok("config" in r && !("contract" in r.config));
});

test("an empty contract gets the defaults", () => {
  const r = resolveConfig({ contract: {} });
  assert.ok("config" in r);
  assert.deepEqual(r.config.contract, { mapFile: "pen-map.json", codeGlobs: [] });
});

test("a valid contract is accepted", () => {
  const contract = {
    mapFile: "design/map.json",
    tokenSource: { kind: "css", path: "src/tokens.css", selectors: [":root"], themes: { "mode=dark": "[data-theme=dark]", "brand=a,mode=dark": ".a.dark" } },
    codeGlobs: ["src/**/*.tsx"],
  };
  const r = resolveConfig({ contract });
  assert.ok("config" in r);
  assert.deepEqual(r.config.contract, contract);
  const d = resolveConfig({ contract: { tokenSource: { kind: "dtcg", path: "t.json", themes: { "mode=dark": "t.dark.json" } } } });
  assert.ok("config" in d);
  assert.deepEqual(d.config.contract?.tokenSource, { kind: "dtcg", path: "t.json", themes: { "mode=dark": "t.dark.json" } });
});

test("invalid contract fields are config errors", () => {
  assert.equal(err("x"), "contract must be an object");
  assert.equal(err([]), "contract must be an object");
  assert.equal(err({ nope: 1 }), 'unknown contract key "nope"');
  assert.match(err({ mapFile: "" }), /^contract\.mapFile must be a non-empty repo-relative path/);
  assert.match(err({ mapFile: 3 }), /^contract\.mapFile /);
  assert.match(err({ mapFile: "/etc/map.json" }), /^contract\.mapFile /);
  assert.match(err({ mapFile: "../map.json" }), /^contract\.mapFile /);
  assert.match(err({ mapFile: "a/../../map.json" }), /^contract\.mapFile /);
  assert.match(err({ codeGlobs: "src" }), /^contract\.codeGlobs /);
  assert.match(err({ codeGlobs: [""] }), /^contract\.codeGlobs /);
  assert.match(err({ codeGlobs: ["/abs/**"] }), /^contract\.codeGlobs /);
  assert.match(err({ codeGlobs: ["../x/**"] }), /^contract\.codeGlobs /);
  assert.match(err({ codeGlobs: [":(top)x"] }), /^contract\.codeGlobs /);
  for (const bad of ["..\\x", "C:/x", "a\0b"]) {
    assert.match(err({ mapFile: bad }), /^contract\.mapFile /);
    assert.match(err({ codeGlobs: [bad] }), /^contract\.codeGlobs /);
    assert.match(err({ tokenSource: { kind: "css", path: bad } }), /^contract\.tokenSource\.path /);
  }
});

test("invalid tokenSource fields are config errors", () => {
  const ts = (extra: Record<string, unknown>) => err({ tokenSource: { kind: "css", path: "t.css", ...extra } });
  assert.equal(err({ tokenSource: "x" }), "contract.tokenSource must be an object");
  assert.equal(err({ tokenSource: { path: "t.css" } }), "contract.tokenSource.kind must be one of css, dtcg");
  assert.equal(err({ tokenSource: { kind: "scss", path: "t.css" } }), "contract.tokenSource.kind must be one of css, dtcg");
  assert.match(err({ tokenSource: { kind: "css" } }), /^contract\.tokenSource\.path /);
  assert.match(ts({ path: "" }), /^contract\.tokenSource\.path /);
  assert.match(ts({ path: "/abs.css" }), /^contract\.tokenSource\.path /);
  assert.match(ts({ path: "../t.css" }), /^contract\.tokenSource\.path /);
  assert.equal(ts({ extra: 1 }), 'contract.tokenSource has an unknown key "extra"');
  assert.match(ts({ selectors: ":root" }), /^contract\.tokenSource\.selectors /);
  assert.match(ts({ selectors: [""] }), /^contract\.tokenSource\.selectors /);
  assert.match(err({ tokenSource: { kind: "dtcg", path: "t.json", selectors: [":root"] } }), /selectors is only valid for kind css/);
  assert.match(ts({ themes: [] }), /^contract\.tokenSource\.themes /);
  assert.match(ts({ themes: { "": ".x" } }), /themes key ""/);
  assert.match(ts({ themes: { default: ".x" } }), /themes key "default"/);
  assert.match(ts({ themes: { dark: ".x" } }), /themes key "dark"/);
  assert.match(ts({ themes: { "mode=": ".x" } }), /themes key "mode="/);
  assert.match(ts({ themes: { "mode=dark,brand=a": ".x" } }), /themes key "mode=dark,brand=a"/, "axes must be sorted");
  assert.match(ts({ themes: { "mode=dark,mode=light": ".x" } }), /themes key/, "axes must be unique");
  assert.match(ts({ themes: { "mode=dark": "" } }), /themes\["mode=dark"\] must be a non-empty selector/);
  assert.match(ts({ themes: { "mode=dark": 1 } }), /themes\["mode=dark"\]/);
  assert.match(err({ tokenSource: { kind: "dtcg", path: "t.json", themes: { "mode=dark": "../d.json" } } }), /themes\["mode=dark"\] must be a non-empty repo-relative path/);
  assert.match(err({ tokenSource: { kind: "dtcg", path: "t.json", themes: { "mode=dark": "/d.json" } } }), /themes\["mode=dark"\]/);
});
