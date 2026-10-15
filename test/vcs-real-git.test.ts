import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createDesignRepo,
  createSafeGit,
  createVcsExecFileGit,
  getUnsavedChanges,
  resolveVersion,
  VcsCommitFailedError,
  VcsRefusedError,
} from "../src/index.js";

const ISOLATED = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
// Config isolation only: the identity must come from the repo-local values `init` sets.
const NO_IDENTITY = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

async function folder() {
  return realpath(await mkdtemp(path.join(os.tmpdir(), "vcs-real-")));
}
const rawGit = (dir: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: dir, env: { ...process.env, ...ISOLATED }, encoding: "utf8" });
const make = (dir: string, env: NodeJS.ProcessEnv = ISOLATED, clock?: () => Date) =>
  createDesignRepo({ repo: dir, exec: createVcsExecFileGit(dir, env), clock });

test("init, idempotent re-run, status, save, history with renames and gaps", async () => {
  const dir = await folder();
  await writeFile(path.join(dir, "a.pen"), "1");
  await writeFile(path.join(dir, "notes.txt"), "n");
  const repo = make(dir, NO_IDENTITY, () => new Date(2026, 0, 2, 3, 4));

  const first = await repo.init();
  assert.equal(first.createdRepo, true);
  assert.deepEqual(first.identitySet, ["user.name", "user.email"]);
  assert.equal(first.saved?.message, "First version");
  assert.equal(rawGit(dir, "config", "--local", "user.name").trim(), "Designer");
  assert.equal((await readFile(path.join(dir, ".gitignore"), "utf8")), "/design-diff/\n");
  assert.deepEqual(rawGit(dir, "show", "--name-only", "--format=").trim().split("\n"), ["a.pen"]);

  const again = await repo.init();
  assert.equal(again.changed, false);
  assert.equal(again.summary, "Nothing changed: this folder is already set up for versions.");
  assert.equal((await readFile(path.join(dir, ".gitignore"), "utf8")), "/design-diff/\n");

  assert.equal((await repo.status()).clean, true);
  assert.equal((await repo.save()).saved, false);

  // No assets/ directory exists: save must still work, and files staged outside .pen/assets stay out.
  await writeFile(path.join(dir, "a.pen"), "2");
  await writeFile(path.join(dir, "staged.txt"), "s");
  rawGit(dir, "add", "staged.txt");
  const st = await repo.status();
  assert.deepEqual(st.files, [{ path: "a.pen", state: "changed" }]);
  assert.equal(st.exploration, "main");
  const second = await repo.save();
  assert.equal(second.message, "Saved 2026-01-02 03:04");
  assert.deepEqual(rawGit(dir, "show", "--name-only", "--format=").trim().split("\n"), ["a.pen"]);
  assert.equal(rawGit(dir, "status", "--porcelain").includes("A  staged.txt"), true);

  await rename(path.join(dir, "a.pen"), path.join(dir, "b.pen"));
  await writeFile(path.join(dir, "c.pen"), "3");
  await mkdir(path.join(dir, "assets"));
  await writeFile(path.join(dir, "assets", "p.png"), "png");
  const st2 = await repo.status();
  assert.deepEqual(st2.files.map((f) => [f.path, f.state]).sort(), [["a.pen", "deleted"], ["assets/p.png", "new"], ["b.pen", "new"], ["c.pen", "new"]]);
  const third = await repo.save({ message: "Third" });
  assert.equal(third.files.length, 4);
  await writeFile(path.join(dir, "c.pen"), "4");
  await repo.save({ message: "Fourth" });
  await writeFile(path.join(dir, "b.pen"), "5");
  await repo.save({ message: "Fifth" });

  const h = await repo.history();
  assert.deepEqual(h.versions.map((v) => [v.number, v.message]), [[1, "Fifth"], [2, "Fourth"], [3, "Third"], [4, "Saved 2026-01-02 03:04"], [5, "First version"]]);
  assert.match(h.versions[0].date, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d)$/);
  assert.deepEqual(h.versions[2].files.sort(), ["assets/p.png", "b.pen", "c.pen"]);

  const limited = await repo.history({ limit: 2 });
  assert.deepEqual(limited.versions.map((v) => v.number), [1, 2]);

  const fh = await repo.history({ file: "b.pen" });
  assert.deepEqual(fh.versions.map((v) => v.number), [1, 3, 4, 5]);
  assert.equal((await repo.resolveVersion("#3")).sha, fh.versions[1].sha);
  assert.equal((await repo.resolveVersion(fh.versions[0].shortId)).sha, fh.versions[0].sha);
  assert.equal((await repo.resolveVersion("main")).sha, h.versions[0].sha);
});

test("parsers against real git: status, config exit, for-each-ref, unborn history", async () => {
  const dir = await folder();
  const repo = make(dir);
  await assert.rejects(repo.status(), VcsRefusedError);
  rawGit(dir, "init", "-q", "-b", "main");
  const git = createSafeGit(createVcsExecFileGit(dir, ISOLATED));
  assert.equal((await repo.history()).versions.length, 0);
  await assert.rejects(resolveVersion(git, "#1"), /No versions saved yet/);

  await writeFile(path.join(dir, "n.pen"), "1");
  await writeFile(path.join(dir, "other.txt"), "x");
  await mkdir(path.join(dir, "assets", "deep"), { recursive: true });
  await writeFile(path.join(dir, "assets", "deep", "i.png"), "x");
  const u = await getUnsavedChanges(git);
  assert.deepEqual(u.files.map((f) => f.path).sort(), ["assets/deep/i.png", "n.pen"]);

  await repo.save({ message: "one" });
  rawGit(dir, "branch", "idea");
  await writeFile(path.join(dir, "n.pen"), "2");
  rawGit(dir, "mv", "n.pen", "m.pen");
  assert.deepEqual((await getUnsavedChanges(git)).files, [{ path: "m.pen", state: "changed", oldPath: "n.pen" }]);
  await repo.save({ message: "two" });
  assert.equal((await resolveVersion(git, "idea")).label, 'exploration "idea"');
  assert.equal((await resolveVersion(git, "main")).label, 'exploration "main"');
  await assert.rejects(resolveVersion(git, "#9"), /no version #9/);
  await assert.rejects(resolveVersion(git, "nope"), /called "nope"/);
  await rm(path.join(dir, "m.pen"));
  assert.deepEqual((await getUnsavedChanges(git)).files, [{ path: "m.pen", state: "deleted" }]);
});

test("init inside an enclosing repo is refused and leaves the parent alone", async () => {
  const outer = await folder();
  rawGit(outer, "init", "-q", "-b", "main");
  const inner = path.join(outer, "designs");
  await mkdir(inner);
  await writeFile(path.join(inner, "a.pen"), "1");
  await assert.rejects(make(inner).init(), VcsRefusedError);
  await assert.rejects(readFile(path.join(outer, ".gitignore")), { code: "ENOENT" });
  assert.equal(rawGit(outer, "status", "--porcelain").trim(), "?? designs/");
});

test("real git: failing gpg signing is classified from verbatim stderr", async () => {
  const dir = await folder();
  const repo = make(dir);
  await repo.init();
  rawGit(dir, "config", "--local", "gpg.program", "/bin/false");
  rawGit(dir, "config", "--local", "commit.gpgsign", "true");
  await writeFile(path.join(dir, "a.pen"), "1");
  await assert.rejects(repo.save({ message: "m" }), (e) => {
    assert.ok(e instanceof VcsCommitFailedError);
    const prefix = "Saving failed because your git setup signs versions and signing failed: error: gpg failed to sign the data";
    assert.ok([prefix, prefix + ":"].includes(e.message), e.message); // newer git appends a colon
    return true;
  });
  // Nothing extra was done to the index: git left the file staged by `add`.
  assert.equal(rawGit(dir, "status", "--porcelain").trim().includes("A  a.pen"), true);
});

test("real git: a failing pre-commit hook has no git preamble, so it reports the hook's own first line", async () => {
  const dir = await folder();
  const repo = make(dir);
  await repo.init();
  const hooks = path.join(dir, ".hooks");
  await mkdir(hooks);
  await writeFile(path.join(hooks, "pre-commit"), '#!/bin/sh\necho "lint failed" >&2\nexit 1\n');
  await chmod(path.join(hooks, "pre-commit"), 0o755);
  rawGit(dir, "config", "--local", "core.hooksPath", hooks);
  await writeFile(path.join(dir, "a.pen"), "1");
  // Git prints nothing itself for a failing hook, so unless the hook names itself this is the generic message.
  await assert.rejects(repo.save({ message: "m" }), (e) => {
    assert.ok(e instanceof VcsCommitFailedError);
    assert.equal(e.reason, "other");
    assert.equal(e.message, "Saving failed: lint failed");
    return true;
  });
});

test("restore never changes history: git log is identical before and after; no assets/ folder needed", async () => {
  const dir = await folder();
  await writeFile(path.join(dir, "a.pen"), "1");
  const repo = make(dir);
  await repo.init();
  await writeFile(path.join(dir, "a.pen"), "2");
  await writeFile(path.join(dir, "b.pen"), "new");
  await repo.save({ message: "Two" });
  await writeFile(path.join(dir, "a.pen"), "3");
  await repo.save({ message: "Three" });

  const before = rawGit(dir, "log", "--format=%H", "--all");
  const branchesBefore = rawGit(dir, "for-each-ref", "--format=%(refname) %(objectname)");
  const out = await repo.restore({ version: "3" });
  assert.equal(rawGit(dir, "log", "--format=%H", "--all"), before);
  assert.equal(rawGit(dir, "for-each-ref", "--format=%(refname) %(objectname)"), branchesBefore);
  assert.equal(out.restored, true);
  assert.equal(await readFile(path.join(dir, "a.pen"), "utf8"), "1");
  await assert.rejects(readFile(path.join(dir, "b.pen"), "utf8"), /ENOENT/);
  assert.equal((await repo.status()).clean, false);

  await assert.rejects(repo.restore({ version: "1" }), VcsRefusedError);
  const again = await repo.restore({ version: "1", saveFirst: true });
  assert.equal(again.savedFirst?.message, "Before restore to #1");
  assert.equal(rawGit(dir, "log", "--max-count=1", "--format=%s"), "Before restore to #1\n");
  assert.equal(await readFile(path.join(dir, "a.pen"), "utf8"), "3");
});

test("restore is refused for a never-saved .pen; explore and switch work on real history", async () => {
  const dir = await folder();
  await writeFile(path.join(dir, "a.pen"), "1");
  const repo = make(dir);
  await repo.init();
  await writeFile(path.join(dir, "new.pen"), "x");
  await assert.rejects(repo.restore({ version: "1" }), VcsRefusedError);
  await assert.rejects(repo.explore({ name: "idea" }), VcsRefusedError);
  await rm(path.join(dir, "new.pen"));

  const created = await repo.explore({ name: "idea" });
  assert.equal(created.exploration, "idea");
  assert.deepEqual((await repo.explore()).explorations, [{ name: "idea", current: true }, { name: "main", current: false }]);
  await assert.rejects(repo.explore({ name: "idea" }), /already an exploration/);
  await assert.rejects(repo.explore({ name: "bad name" }), /can't be used/);
  await writeFile(path.join(dir, "a.pen"), "2");
  await assert.rejects(repo.switchTo("main"), /design save/);
  await repo.save({ message: "On idea" });
  assert.equal((await repo.switchTo("main")).switched, true);
  assert.equal(await readFile(path.join(dir, "a.pen"), "utf8"), "1");
  await assert.rejects(repo.switchTo("nope"), /no exploration/);
});

test("compare writes a real report between a saved version and the working files", async () => {
  const { compare } = await import("../src/index.js");
  const { defaultFs } = await import("../src/cli/run-diff.js");
  const { WHITE, fakeRenderer, makePng, render } = await import("./helpers/png.js");
  const pen = (color: string) =>
    JSON.stringify({ version: "2.10", children: [{ type: "frame", id: "f1", name: "F", layout: "none", width: 8, height: 8, children: [{ type: "rectangle", id: "r1", name: "R", fill: color, x: 0, y: 0, width: 4, height: 4 }] }] });
  const dir = await folder();
  await writeFile(path.join(dir, "a.pen"), pen("#ff0000"));
  const repo = make(dir);
  await repo.init();
  await writeFile(path.join(dir, "a.pen"), pen("#00ff00"));
  const renderer = fakeRenderer(() => render(makePng(8, 8, WHITE), { f1: { x: 0, y: 0, w: 8, h: 8 }, r1: { x: 0, y: 0, w: 4, h: 4 } }));
  const opened: string[] = [];
  const log = rawGit(dir, "log", "--format=%H");
  const r = await compare(
    { open: true },
    {
      repo: dir,
      exec: createVcsExecFileGit(dir, ISOLATED),
      diff: { cwd: dir, tmpdir: os.tmpdir(), stdout() {}, stderr() {}, fs: defaultFs, gitDirs: async () => [], createRenderer: () => renderer },
      openFile: async (f) => void opened.push(f),
    },
  );
  assert.equal(r.reportPath, path.join(dir, "design-diff", "report.html"));
  assert.ok((await readFile(r.reportPath, "utf8")).length > 0);
  assert.equal(r.files, 1);
  assert.deepEqual(opened, [r.reportPath]);
  assert.equal(rawGit(dir, "log", "--format=%H"), log);
});
