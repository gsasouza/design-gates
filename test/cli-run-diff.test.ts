import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { InvalidRefError, type ChangedFile, type GitReader } from "../src/git/reader.js";
import { runDiff, type DiffDeps, type RunFs } from "../src/cli/run-diff.js";
import { BLACK, WHITE, fakeRenderer, fillRect, makePng, render } from "./helpers/png.js";

const penText = (color: string): string =>
  JSON.stringify({
    version: "2.10",
    children: [
      { type: "frame", id: "f1", name: "F", layout: "none", width: 8, height: 8, children: [{ type: "rectangle", id: "r1", name: "R", fill: color, x: 0, y: 0, width: 4, height: 4 }] },
    ],
  });

function fakeGit(changed: ChangedFile[], calls: string[] = []): GitReader {
  return {
    async mergeBase(a, b) {
      calls.push(`mergeBase ${a} ${b}`);
      if (a === "nope") throw new InvalidRefError(a, "does not resolve to a commit");
      return `sha-${a}`;
    },
    async listChangedPenFiles(base, head, globs) {
      calls.push(`list ${base} ${String(head)} ${globs.join("|")}`);
      return changed;
    },
    async readBlob(ref) {
      return penText(ref.includes("base") || ref.includes("main") ? "#ff0000" : "#00ff00");
    },
    async readWorktree() {
      return penText("#00ff00");
    },
  };
}

function memoryFs(opts: { symlinks?: Record<string, string>; failWritesTo?: string } = {}) {
  const files = new Map<string, string | Uint8Array>();
  const dirs = new Set<string>();
  const removed: string[] = [];
  const temps: string[] = [];
  let counter = 0;
  const fs: RunFs = {
    async mkdir(dir) {
      dirs.add(dir);
    },
    async mkdtemp(prefix) {
      const dir = `${prefix}${counter++}`;
      temps.push(dir);
      dirs.add(dir);
      return dir;
    },
    async writeFile(file, data) {
      if (opts.failWritesTo && file.startsWith(opts.failWritesTo)) throw new Error("disk full");
      files.set(file, data);
    },
    async readFile(file) {
      const d = files.get(file);
      if (d === undefined) throw new Error(`ENOENT ${file}`);
      return typeof d === "string" ? Buffer.from(d) : d;
    },
    async rm(target) {
      removed.push(target);
      for (const k of [...files.keys()]) if (k === target || k.startsWith(target + path.sep)) files.delete(k);
      for (const k of [...dirs]) if (k === target || k.startsWith(target + path.sep)) dirs.delete(k);
    },
    async cp() {},
    async realpath(target) {
      for (const [link, to] of Object.entries(opts.symlinks ?? {})) {
        if (target === link || target.startsWith(link + path.sep)) return to + target.slice(link.length);
      }
      if (dirs.has(target) || files.has(target) || target === "/" || target === "/repo" || target === "/repo/.git" || target === "/work") return target;
      throw new Error("ENOENT");
    },
    async exists(target) {
      return files.has(target) || [...files.keys(), ...dirs].some((k) => k === target || k.startsWith(target + path.sep));
    },
    async listFiles(dir) {
      return [...files.keys()].filter((k) => k.startsWith(dir + path.sep)).map((k) => k.slice(dir.length + 1).split(path.sep).join("/"));
    },
  };
  return { fs, files, dirs, removed, temps };
}

function setup(changed: ChangedFile[], fsOpts: Parameters<typeof memoryFs>[0] = {}, gitDirs: string[] = ["/repo/.git", "/repo/.git"]) {
  const mem = memoryFs(fsOpts);
  const out: string[] = [];
  const err: string[] = [];
  const gitCalls: string[] = [];
  const renderer = fakeRenderer((doc) => {
    const red = JSON.stringify(doc).includes("#ff0000");
    return render(makePng(8, 8, WHITE, red ? undefined : (set) => fillRect(set, 0, 0, 4, 4, BLACK)), { f1: { x: 0, y: 0, w: 8, h: 8 }, r1: { x: 0, y: 0, w: 4, h: 4 } });
  });
  const deps: DiffDeps = {
    cwd: "/work",
    tmpdir: "/tmp",
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
    fs: mem.fs,
    gitDirs: async () => gitDirs,
    git: fakeGit(changed, gitCalls),
    createRenderer: (scale) => {
      rendererScales.push(scale);
      return renderer;
    },
  };
  return { deps, mem, out, err, gitCalls, renderer };
}
const rendererScales: number[] = [];

test("defaults: repo=cwd, merge-base with main, worktree head, ./design-diff", async () => {
  const s = setup([{ path: "a.pen", status: "modified" }]);
  const code = await runDiff({}, s.deps);
  assert.equal(code, 0);
  assert.ok(s.gitCalls.includes("mergeBase main HEAD"));
  assert.ok(s.gitCalls.some((c) => c.startsWith("list sha-") && c.includes("Symbol(worktree)")));
  for (const f of ["report.html", "diff.json"]) assert.ok(s.mem.files.has(path.join("/work/design-diff", f)), f);
  assert.ok([...s.mem.files.keys()].some((k) => k.startsWith("/work/design-diff/images/") && k.endsWith("-diff.png")));
  assert.equal(rendererScales.at(-1), 1);
});

test("exit 0 with changes, prints counts and the output path", async () => {
  const s = setup([{ path: "a.pen", status: "modified" }]);
  const code = await runDiff({ base: "base", head: "head", out: "o", scale: 2, threshold: 0.2, paths: ["*.pen"] }, s.deps);
  assert.equal(code, 0);
  assert.equal(rendererScales.at(-1), 2);
  assert.match(s.out.join(""), /1 file\(s\), 1 frame\(s\), 1 change\(s\)/);
  assert.match(s.out.join(""), /\/work\/o\/report\.html/);
  assert.deepEqual(s.err, []);
  const json = JSON.parse(String(s.mem.files.get("/work/o/diff.json")));
  assert.equal(json.files[0].frames[0].nodes[0].props[0].path, "fill");
  assert.deepEqual(json.base, { ref: "base", sha: "sha-base" });
  assert.ok(s.gitCalls.includes("list sha-base sha-head *.pen"));
  const html = String(s.mem.files.get("/work/o/report.html"));
  assert.match(html, /images\/a\.pen-/);
  assert.doesNotMatch(html, /data:image\/png/);
});

test("--inline embeds images in report.html", async () => {
  const s = setup([{ path: "a.pen", status: "modified" }]);
  assert.equal(await runDiff({ base: "base", head: "head", out: "o", inline: true }, s.deps), 0);
  const html = String(s.mem.files.get("/work/o/report.html"));
  assert.match(html, /data:image\/png;base64,/);
  assert.doesNotMatch(html, /src="images\//);
});

test("exit 0 and an empty report when there are no .pen changes", async () => {
  const s = setup([]);
  assert.equal(await runDiff({ base: "base", head: "head", out: "o" }, s.deps), 0);
  assert.match(s.out.join(""), /0 file\(s\), 0 frame\(s\), 0 change\(s\)/);
  const json = JSON.parse(String(s.mem.files.get("/work/o/diff.json")));
  assert.deepEqual(json.files, []);
  assert.ok(s.mem.files.has("/work/o/report.html"));
});

test("a bad ref exits non-zero with the message on stderr and stdout stays empty", async () => {
  const s = setup([{ path: "a.pen", status: "modified" }]);
  const code = await runDiff({ base: "nope", out: "o" }, s.deps);
  assert.notEqual(code, 0);
  assert.match(s.err.join(""), /Invalid git ref "nope"/);
  assert.deepEqual(s.out, []);
  assert.equal(s.mem.files.size, 0);
});

test("a path that is not a git repository is an error", async () => {
  const s = setup([]);
  s.deps.gitDirs = async () => {
    throw new Error("Not a git repository: /x");
  };
  assert.notEqual(await runDiff({ repo: "/x", out: "o" }, s.deps), 0);
  assert.match(s.err.join(""), /Not a git repository/);
});

test("invalid numeric options are rejected before any work", async () => {
  for (const bad of [{ threshold: 1.5 }, { threshold: -1 }, { threshold: NaN }, { scale: 0 }, { scale: -2 }, { scale: 100 }]) {
    const s = setup([]);
    assert.notEqual(await runDiff({ ...bad, out: "o" }, s.deps), 0, JSON.stringify(bad));
    assert.match(s.err.join(""), /--(threshold|scale)/);
    assert.deepEqual(s.gitCalls, []);
  }
  const s = setup([]);
  assert.notEqual(await runDiff({ base: "--evil" }, s.deps), 0);
  assert.match(s.err.join(""), /--base/);
});

test("refuses to write into the repo's .git dir, including via a symlink and a missing subdir", async () => {
  for (const out of ["/repo/.git", "/repo/.git/design-diff", "/repo/.git/deep/er"]) {
    const s = setup([]);
    assert.notEqual(await runDiff({ repo: "/repo", out }, s.deps), 0, out);
    assert.match(s.err.join(""), /Refusing to write into the git directory/);
    assert.equal(s.mem.files.size, 0);
    assert.deepEqual(s.mem.temps, []);
  }
  const s = setup([], { symlinks: { "/work/link": "/repo/.git" } });
  assert.notEqual(await runDiff({ repo: "/repo", out: "link/sub" }, s.deps), 0);
  assert.match(s.err.join(""), /Refusing to write into the git directory/);
  assert.equal(s.mem.files.size, 0);
});

test("refuses the common git dir of a linked worktree", async () => {
  const s = setup([], {}, ["/repo/.git/worktrees/w", "/repo/.git"]);
  assert.notEqual(await runDiff({ repo: "/repo", out: "/repo/.git/x" }, s.deps), 0);
  assert.match(s.err.join(""), /Refusing to write/);
});

test("writing under the worktree is allowed", async () => {
  const s = setup([]);
  assert.equal(await runDiff({ repo: "/repo", out: "/repo/design-diff" }, s.deps), 0);
  assert.ok(s.mem.files.has("/repo/design-diff/diff.json"));
});

test("the temp dir under tmpdir is removed on success and on error", async () => {
  const ok = setup([{ path: "a.pen", status: "modified" }]);
  assert.equal(await runDiff({ base: "base", head: "head", out: "o" }, ok.deps), 0);
  assert.equal(ok.mem.temps.length, 1);
  assert.ok(ok.mem.temps[0]!.startsWith("/tmp/design-gates-"));
  assert.ok(ok.mem.removed.includes(ok.mem.temps[0]!));
  assert.ok([...ok.mem.files.keys()].every((k) => !k.startsWith("/tmp/")));

  const bad = setup([{ path: "a.pen", status: "modified" }]);
  bad.deps.createRenderer = () => ({
    async renderFrame() {
      throw new Error("render exploded");
    },
  });
  assert.notEqual(await runDiff({ base: "base", head: "head", out: "o" }, bad.deps), 0);
  assert.match(bad.err.join(""), /render exploded/);
  assert.equal(bad.mem.temps.length, 1);
  assert.ok(bad.mem.removed.includes(bad.mem.temps[0]!));
  assert.ok(!bad.mem.files.has("/work/o/diff.json"));

  const full = setup([{ path: "a.pen", status: "modified" }], { failWritesTo: "/work/o" });
  assert.notEqual(await runDiff({ base: "base", head: "head", out: "o" }, full.deps), 0);
  assert.match(full.err.join(""), /disk full/);
  assert.ok(full.mem.removed.includes(full.mem.temps[0]!));
});

test("<out>/images is only cleared when a previous diff.json exists", async () => {
  const fresh = setup([]);
  fresh.mem.files.set("/work/o/images/keep.png", "x");
  assert.equal(await runDiff({ out: "o" }, fresh.deps), 0);
  assert.ok(fresh.mem.files.has("/work/o/images/keep.png"));

  const again = setup([]);
  again.mem.files.set("/work/o/images/stale.png", "x");
  again.mem.files.set("/work/o/diff.json", "{}");
  assert.equal(await runDiff({ out: "o" }, again.deps), 0);
  assert.ok(!again.mem.files.has("/work/o/images/stale.png"));
});
