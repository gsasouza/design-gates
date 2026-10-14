import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPenFile, parsePen } from "../src/index.js";
import { fixtureUrl } from "./helpers/fixtures.js";

test("parses JSONC with comments and trailing commas", () => {
  const doc = parsePen(`{
    // line comment
    "version": "2.6", /* block */
    "note": "keeps // and , ] inside strings",
    "children": [
      { "id": "a", "type": "frame", },
    ],
  }`);
  assert.equal(doc.version, "2.6");
  assert.equal(doc.children.length, 1);
  assert.equal(doc.children[0]!.id, "a");
  assert.equal(doc["note" as never], "keeps // and , ] inside strings");
});

test("loads fixtures/minimal.pen", async () => {
  const doc = await loadPenFile(fixtureUrl("minimal.pen"));
  assert.equal(doc.version, "2.6");
  assert.deepEqual(doc.themes, { mode: ["light", "dark"] });
  assert.equal(doc.variables?.bg?.type, "color");
  assert.equal(doc.children[0]!.children![0]!.reusable, true);
  assert.equal(doc.children[1]!.ref, "btn");
});

test("throws a clear error on invalid input", () => {
  assert.throws(() => parsePen("{ not json"), /Invalid \.pen document/);
  assert.throws(() => parsePen("[]"), /root must be an object/);
  assert.throws(() => parsePen('{"children": []}'), /"version"/);
  assert.throws(() => parsePen('{"version": "1"}'), /"children"/);
});
