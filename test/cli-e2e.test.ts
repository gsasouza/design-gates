import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { JSDOM } from "jsdom";
import { createFixtureRepo, type FixtureRepo } from "./helpers/fixture-repo.js";
import { loadExpected } from "./helpers/expected.js";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" };
const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await run("git", ["--no-optional-locks", ...args], { cwd, env: gitEnv })).stdout;
const cli = (args: string[], cwd?: string) =>
  run(process.execPath, [CLI, ...args], { ...(cwd && { cwd }), env: gitEnv, maxBuffer: 256 * 1024 * 1024 });

let fx: FixtureRepo;
let outA: string;
let outB: string;
let stdout: string;
let statusBefore: string;
let headBefore: string;
let statusAfter: string;
let headAfter: string;
let json: { files: { path: string; oldPath?: string; status: string; frames: any[] }[]; variables: any[] };
let html: string;

before(async () => {
  fx = await createFixtureRepo();
  outA = await mkdtemp(path.join(tmpdir(), "dg-out-a-"));
  outB = await mkdtemp(path.join(tmpdir(), "dg-out-b-"));
  statusBefore = await git(fx.path, "status", "--porcelain");
  headBefore = await git(fx.path, "rev-parse", "HEAD");
  stdout = (await cli(["diff", "--repo", fx.path, "--base", "base", "--head", "head", "--out", outA])).stdout;
  await cli(["diff", "--repo", fx.path, "--base", "base", "--head", "head", "--out", outB]);
  statusAfter = await git(fx.path, "status", "--porcelain");
  headAfter = await git(fx.path, "rev-parse", "HEAD");
  json = JSON.parse(await readFile(path.join(outA, "diff.json"), "utf8"));
  html = await readFile(path.join(outA, "report.html"), "utf8");
});
after(async () => {
  await fx.cleanup();
  await rm(outA, { recursive: true, force: true });
  await rm(outB, { recursive: true, force: true });
});

test("the CLI prints a summary with the report path", () => {
  assert.match(stdout, /\d+ file\(s\), \d+ frame\(s\), \d+ change\(s\)/);
  assert.ok(stdout.includes(path.join(outA, "report.html")));
});

test("diff.json contains every edit in fixtures/expected.json with the right change type", () => {
  for (const e of loadExpected()) {
    const label = `${e.file}/${e.frameId}`;
    const file = json.files.find((f) => f.path === e.file);
    if (e.fileStatus === "unchanged") {
      assert.equal(file, undefined, `${label}: unchanged file must not be listed`);
      continue;
    }
    assert.ok(file, `${label}: file present`);
    assert.equal(file.status, e.fileStatus, `${label}: file status`);
    assert.equal(file.oldPath, e.oldPath, `${label}: oldPath`);
    const frame = file.frames.find((f) => f.id === e.frameId);
    assert.ok(frame, `${label}: frame present`);
    if (e.matchedBy !== undefined) assert.equal(frame.matchedBy, e.matchedBy, `${label}: matchedBy`);
    if (e.variable !== undefined) {
      const v = json.variables.find((x) => x.file === e.file && x.name === e.variable && x.theme === e.theme);
      assert.ok(v, `${label}: variable ${e.variable}`);
      assert.equal(v.change, e.change, `${label}: variable change`);
      assert.ok(v.frames.some((r: { file: string; frameId: string }) => r.file === e.file && r.frameId === e.frameId), `${label}: variable lists frame`);
    } else if (e.nodeId !== undefined) {
      const matches = frame.nodes.filter((n: { id: string; change: string }) => n.id === e.nodeId && n.change === e.change);
      assert.equal(matches.length, 1, `${label}: node ${e.nodeId} ${e.change}`);
      if (e.path !== undefined) assert.ok(matches[0].props.some((p: { path: string }) => p.path === e.path), `${label}: prop ${e.path}`);
    } else if (e.change === "none") {
      assert.equal(frame.status, "unchanged", `${label}: frame unchanged`);
      assert.deepEqual(frame.nodes, [], `${label}: no node changes`);
    } else {
      assert.equal(frame.status, e.change, `${label}: frame status`);
    }
  }
});

test("the per-theme variable edit has pixels changed under its theme key and the report offers the theme switcher", () => {
  const frames = json.files.find((f) => f.path === "variable.pen")!.frames;
  for (const id of ["var-frame", "var-comp-frame"]) {
    const frame = frames.find((f) => f.id === id);
    assert.ok(frame.pixelDiffRatio["mode=dark"] > 0, `${id}: mode=dark ratio`);
    assert.equal(frame.pixelDiffRatio.default, 0, `${id}: default theme unchanged`);
    assert.ok(frame.images["mode=dark"].diff, `${id}: dark diff image`);
  }
  const doc = new JSDOM(html).window.document;
  for (const id of ["var-frame", "var-comp-frame"]) {
    const index = [...doc.querySelectorAll("section.frame")].findIndex((s) => s.querySelector("h3")!.textContent === frames.find((f) => f.id === id).name);
    assert.notEqual(index, -1, `${id}: has a section`);
    const select = doc.querySelectorAll("section.frame")[index]!.querySelector("select.theme-select")!;
    assert.deepEqual([...select.querySelectorAll("option")].map((o) => o.getAttribute("value")), ["default", "mode=dark"]);
  }
});

test("frames with missingBoxes show the note", () => {
  const missing = json.files.flatMap((f) => f.frames).filter((fr) => fr.missingBoxes.length > 0);
  const doc = new JSDOM(html).window.document;
  assert.equal(doc.querySelectorAll("p.missing-note").length, missing.length);
  for (const fr of missing) {
    for (const id of fr.missingBoxes) assert.ok([...doc.querySelectorAll("p.missing-note code")].some((c) => c.textContent === id));
  }
});

test("report.html has no external URLs and every view mode", () => {
  assert.doesNotMatch(html, /(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\//i);
  assert.doesNotMatch(html, /url\(\s*["']?(?:https?:)?\/\//i);
  assert.doesNotMatch(html, /@import|<link\b/i);
  const doc = new JSDOM(html).window.document;
  const views = new Set([...doc.querySelectorAll(".view")].map((v) => v.getAttribute("data-view")));
  for (const v of ["side", "swipe", "onion", "diff"]) assert.ok(views.has(v), `view ${v}`);
  const kinds = new Set<string>();
  for (const fr of json.files.flatMap((f) => f.frames)) for (const n of fr.nodes) kinds.add(n.change);
  assert.deepEqual([...kinds].sort(), ["added", "modified", "moved", "removed", "reordered"]);
  for (const k of kinds) assert.ok(doc.querySelector(`.box[data-kind="${k}"]`), `emphasis box for ${k}`);
});

test("image refs in report.html resolve to files in <out>/images and match diff.json", async () => {
  const doc = new JSDOM(html).window.document;
  const srcs = [...doc.querySelectorAll("img")].map((i) => i.getAttribute("src")!);
  assert.ok(srcs.length > 0);
  for (const s of srcs) {
    assert.match(s, /^images\/.+\.png$/);
    assert.ok(existsSync(path.join(outA, ...s.split("/"))), s);
  }
  const listed = new Set(
    json.files.flatMap((f) => f.frames).flatMap((fr) => Object.values(fr.images ?? {}) as Record<string, string>[]).flatMap((m) => Object.values(m)),
  );
  const onDisk = (await readdir(path.join(outA, "images"), { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => path.relative(outA, path.join(e.parentPath, e.name)).split(path.sep).join("/"));
  assert.deepEqual([...listed].sort(), onDisk.sort());
});

test("--inline produces a self-contained report with embedded images", async () => {
  const out = await mkdtemp(path.join(tmpdir(), "dg-out-i-"));
  try {
    await cli(["diff", "--repo", fx.path, "--base", "base", "--head", "head", "--out", out, "--inline"]);
    const inline = await readFile(path.join(out, "report.html"), "utf8");
    assert.match(inline, /src="data:image\/png;base64,/);
    assert.doesNotMatch(inline, /src="images\//);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("two runs produce byte-identical diff.json and report.html", async () => {
  for (const f of ["diff.json", "report.html"]) {
    assert.equal(await readFile(path.join(outB, f), "utf8"), await readFile(path.join(outA, f), "utf8"), f);
  }
});

test("the diffed repo's git status and HEAD are unchanged", () => {
  assert.equal(statusAfter, statusBefore);
  assert.equal(statusAfter, "");
  assert.equal(headAfter, headBefore);
});

test("errors exit non-zero with a message on stderr and no output", async () => {
  const out = await mkdtemp(path.join(tmpdir(), "dg-out-e-"));
  try {
    await assert.rejects(cli(["diff", "--repo", fx.path, "--base", "no-such-ref", "--out", path.join(out, "x")]), (err: any) => {
      assert.notEqual(err.code, 0);
      assert.match(err.stderr, /no-such-ref/);
      return true;
    });
    assert.equal(existsSync(path.join(out, "x")), false);
    await assert.rejects(cli(["diff", "--repo", fx.path, "--base", "base", "--out", path.join(fx.path, ".git", "dd")]), (err: any) => {
      assert.match(err.stderr, /Refusing to write into the git directory/);
      return true;
    });
    await assert.rejects(cli(["diff", "--repo", out, "--out", path.join(out, "x")]), (err: any) => {
      assert.match(err.stderr, /Not a git repository/);
      return true;
    });
    await assert.rejects(cli(["diff", "--threshold", "2"]), (err: any) => {
      assert.match(err.stderr, /--threshold/);
      return true;
    });
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("defaults: no flags diffs cwd's merge-base with main against the working tree into ./design-diff", async () => {
  // base tag is an ancestor of main's tip; the working tree equals head, so the diff matches base..head.
  const cwdOut = path.join(fx.path, "design-diff");
  const r = await cli(["diff", "--base", "base"], fx.path);
  assert.match(r.stdout, /design-diff/);
  const j = JSON.parse(await readFile(path.join(cwdOut, "diff.json"), "utf8"));
  assert.equal(j.head.sha, "WORKTREE");
  assert.deepEqual(j.files.map((f: { path: string }) => f.path), json.files.map((f) => f.path));
  assert.ok(existsSync(path.join(cwdOut, "report.html")));
  // the one documented exception: the default output lives in the worktree; nothing else changed
  assert.equal((await git(fx.path, "status", "--porcelain")).trim(), "?? design-diff/");
  await rm(cwdOut, { recursive: true, force: true });
});
