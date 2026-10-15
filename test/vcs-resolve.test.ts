import assert from "node:assert/strict";
import { test } from "node:test";
import { createSafeGit, resolveVersion, VcsUsageError } from "../src/index.js";
import { gitError, recordingGit } from "./vcs-helpers.js";

const S = (c: string) => c.repeat(40);
const line = (sha: string, short: string, msg: string) => `${sha}\x1f${short}\x1f${msg}\n`;
const ref = (name: string, sha: string) => `${name} ${sha} ${sha.slice(0, 7)}\n`;

interface World {
  head: boolean;
  current: string[][];
  branches: string[][];
  refs: [string, string][];
}
const main = (): World => ({
  head: true,
  current: [[S("c"), "ccccccc", "three"], [S("b"), "bbbbbbb", "two"], [S("a"), "aaaaaaa", "one"]],
  branches: [[S("c"), "ccccccc", "three"], [S("b"), "bbbbbbb", "two"], [S("a"), "aaaaaaa", "one"], [`abcd${"0".repeat(36)}`, "abcd000", "side"], [`abce${"0".repeat(36)}`, "abce000", "side2"], [`abcd${"1".repeat(36)}`, "abcd111", "side3"]],
  refs: [["main", S("c")], ["idea", S("b")]],
});

function run(w: World, input: string) {
  const rec = recordingGit((a) => {
    if (a[0] === "rev-parse") return w.head ? S("c") : gitError("", 1);
    if (a[0] === "log" && a.includes("--branches")) return w.branches.map(([s, h, m]) => line(s, h, m)).join("");
    if (a[0] === "log") return w.current.map(([s, h, m]) => line(s, h, m)).join("");
    if (a[0] === "for-each-ref") return w.refs.map(([n, s]) => ref(n, s)).join("");
    return undefined;
  });
  return resolveVersion(createSafeGit(rec.exec), input);
}

const ok: [string, string, (w: World) => void, string, string][] = [
  ["#1", "#1", () => {}, S("c"), 'version #1 (ccccccc) "three"'],
  ["bare 2", "2", () => {}, S("b"), 'version #2 (bbbbbbb) "two"'],
  ["#3", "#3", () => {}, S("a"), 'version #3 (aaaaaaa) "one"'],
  ["short id", "aaaaaaa", () => {}, S("a"), 'version aaaaaaa "one"'],
  ["short id upper", "AAAA", () => {}, S("a"), 'version aaaaaaa "one"'],
  ["full id", S("b"), () => {}, S("b"), 'version bbbbbbb "two"'],
  ["exploration", "idea", () => {}, S("b"), 'exploration "idea"'],
  ["main", "main", () => {}, S("c"), 'exploration "main"'],
  ["#n with a branch named like it", "#2", (w) => w.refs.push(["2", S("a")]), S("b"), 'version #2 (bbbbbbb) "two"'],
  ["bare digits matching only a commit id", "1234", (w) => w.branches.push([`1234${"f".repeat(36)}`, "1234fff", "digits"]), `1234${"f".repeat(36)}`, 'version 1234fff "digits"'],
];
for (const [name, input, setup, sha, label] of ok) {
  test(`resolve ok: ${name}`, async () => {
    const w = main();
    setup(w);
    const r = await run(w, input);
    assert.equal(r.sha, sha);
    assert.equal(r.label, label);
    assert.equal(r.shortId, sha.slice(0, 7));
  });
}

const bad: [string, string, (w: World) => void, RegExp][] = [
  ["unknown", "nope", () => {}, /no version, exploration or "main" called "nope"/],
  ["unknown hex", "dead", () => {}, /called "dead"/],
  ["out of range #n", "#9", () => {}, /no version #9.*3 saved versions/],
  ["#0", "#0", () => {}, /no version #0/],
  ["bare out of range", "99", () => {}, /no version #99/],
  ["dash", "-x", () => {}, /can't start with a dash/],
  ["empty", "", () => {}, /Say which version/],
  ["blank", "  ", () => {}, /Say which version/],
  ["ambiguous id prefix matching two", "abcd", () => {}, /could mean more than one thing: version abcd000 "side"; version abcd111 "side3"/],
  ["branch named like a short id", "aaaa", (w) => w.refs.push(["aaaa", S("b")]), /could mean more than one thing: version aaaaaaa "one"; exploration "aaaa"/],
  ["bare digits also a branch", "2", (w) => w.refs.push(["2", S("a")]), /could mean more than one thing: version #2 .*; exploration "2"/],
  ["bare digits also an id prefix", "1234", (w) => { w.current = Array.from({ length: 2000 }, (_, i) => [`${i}`.padStart(40, "e"), "eeeeeee", "m"]); w.branches.push([`1234${"f".repeat(36)}`, "1234fff", "digits"]); }, /could mean more than one thing: version #1234 .*; version 1234fff/],
  ["#n with no versions", "#1", (w) => { w.head = false; w.current = []; }, /No versions saved yet/],
  ["bare n with no versions", "1", (w) => { w.head = false; w.current = []; w.branches = []; }, /No versions saved yet/],
];
for (const [name, input, setup, message] of bad) {
  test(`resolve error: ${name}`, async () => {
    const w = main();
    setup(w);
    await assert.rejects(run(w, input), (e) => {
      assert.ok(e instanceof VcsUsageError);
      assert.equal(e.exitCode, 2);
      assert.match(e.message, message);
      return true;
    });
  });
}
