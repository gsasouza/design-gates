import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { DiffDeps, DiffOptions, RunFs } from "../src/cli/run-diff.js";
import type { DiffResult } from "../src/diff/model.js";
import { compare, createDesignRepo, openerFor, VcsCommitFailedError, VcsRefusedError, VcsUsageError } from "../src/index.js";
import { gitError, porcelain, recordingGit } from "./vcs-helpers.js";

const NL = "--no-optional-locks";
const SPECS = [":(glob)**/*.pen", ":(glob)assets/**"];
const STATUS = [NL, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...SPECS];
const LINE = (sha: string, short: string, msg: string) => `${sha}\x1f${short}\x1f${msg}\n`;
const SHA1 = "a".repeat(40);
const SHA2 = "b".repeat(40);
const SHA3 = "c".repeat(40);
const LOG = LINE(SHA1, "aaaaaaa", "Two") + LINE(SHA2, "bbbbbbb", "One") + LINE(SHA3, "ccccccc", "Zero");

async function tmp() {
  return realpath(await mkdtemp(path.join(os.tmpdir(), "vcs-ops-")));
}

const BANNED = ["reset", "update-ref", "checkout", "clean", "rebase", "push", "merge"];

// ---------- compare ----------

const result = (): DiffResult => ({
  schemaVersion: 1,
  base: { ref: "x", sha: SHA1 },
  head: { ref: "WORKTREE", sha: "WORKTREE" },
  files: [
    { path: "a.pen", status: "modified", frames: [{ nodes: [{}, {}, {}] }, { nodes: [{}, {}] }] },
  ] as unknown as DiffResult["files"],
  variables: [],
  themes: [],
});

async function runCompare(opts: Parameters<typeof compare>[0], extra: { open?: string[] } = {}) {
  const dir = await tmp();
  const rec = recordingGit((a) => {
    if (a[0] === "rev-parse" && a.includes("--end-of-options")) return `${a.at(-1)!.replace("^{commit}", "")}\n`;
    if (a[0] === "rev-parse" && a[1] === "--verify") return "";
    if (a[0] === "log") return LOG;
    if (a[0] === "rev-parse" && a[1] === "--absolute-git-dir") return `${dir}/.git\n`;
    if (a[0] === "rev-parse" && a[2] === "--git-common-dir") return `${dir}/.git\n`;
    if (a[0] === "merge-base") return `${a[1]}\n`;
    return "";
  });
  const seen: { options?: DiffOptions; deps?: DiffDeps } = {};
  const diff = { cwd: "/elsewhere", tmpdir: "/tmp", stdout() {}, stderr() {}, fs: {} as RunFs, gitDirs: async () => [], createRenderer: () => { throw new Error("unused"); } };
  const opened = extra.open ?? [];
  const r = await compare(opts, {
    repo: dir,
    exec: rec.exec,
    diff,
    buildDiffReport: async (options, deps) => {
      seen.options = options;
      seen.deps = deps;
      return { result: result(), out: options.out! };
    },
    openFile: async (f) => void opened.push(f),
  });
  return { r, seen, rec, dir, opened };
}

test("compare defaults: version #1 against the unsaved working files", async () => {
  const { r, seen, dir, opened } = await runCompare({});
  assert.deepEqual(seen.options, { repo: dir, base: SHA1, out: path.join(dir, "design-diff"), paths: [] });
  assert.equal(r.to, null);
  assert.equal(r.from.sha, SHA1);
  assert.deepEqual([r.files, r.frames, r.changes], [1, 2, 5]);
  assert.equal(r.reportPath, path.join(dir, "design-diff", "report.html"));
  assert.equal(r.summary, `5 changes in 2 frames — report: ${r.reportPath}`);
  assert.deepEqual(opened, []);
});

test("compare('3') is version #3 against now; compare('3','1') is #3 against #1", async () => {
  const one = await runCompare({ from: "3" });
  assert.equal(one.seen.options!.base, SHA3);
  assert.ok(!("head" in one.seen.options!));
  const two = await runCompare({ from: "3", to: "1" });
  assert.equal(two.seen.options!.base, SHA3);
  assert.equal(two.seen.options!.head, SHA1);
  assert.equal(two.r.to?.sha, SHA1);
});

test("compare accepts ids and exploration names", async () => {
  const dir = await tmp();
  const rec = recordingGit((a) => {
    if (a[0] === "for-each-ref") return `main ${SHA1} aaaaaaa\nidea ${SHA2} bbbbbbb\n`;
    if (a[0] === "log") return LOG;
    return "";
  });
  let options: DiffOptions | undefined;
  await compare(
    { from: "bbbbbbb", to: "idea" },
    { repo: dir, exec: rec.exec, diff: { cwd: dir, fs: {} } as unknown as DiffDeps, buildDiffReport: async (o) => ((options = o), { result: result(), out: o.out! }) },
  );
  assert.equal(options!.base, SHA2);
  assert.equal(options!.head, SHA2);
});

test("compare passes paths repo-relative, absolute out, and routes git through the wrapper", async () => {
  const { seen, rec, dir } = await runCompare({ paths: ["a/x.pen"], out: "reports" });
  assert.deepEqual(seen.options!.paths, ["a/x.pen"]);
  assert.equal(seen.options!.out, path.resolve("/elsewhere", "reports"));
  assert.deepEqual(await seen.deps!.gitDirs(dir), [`${dir}/.git`, `${dir}/.git`]);
  assert.equal(await seen.deps!.git!.mergeBase(SHA1, SHA2), SHA1);
  assert.ok(rec.calls.some((c) => c.join(" ") === `${NL} merge-base ${SHA1} ${SHA2}`));
  assert.ok(rec.calls.some((c) => c.join(" ") === `${NL} rev-parse --absolute-git-dir`));
  for (const c of rec.calls) assert.equal(c[0], NL);
});

test("compare rejects paths that escape the folder", async () => {
  await assert.rejects(runCompare({ paths: ["../x.pen"] }), VcsUsageError);
});

test("compare open calls the opener exactly once with the report path", async () => {
  const { r, opened } = await runCompare({ open: true });
  assert.deepEqual(opened, [r.reportPath]);
  const none = await runCompare({ open: false });
  assert.deepEqual(none.opened, []);
});

test("compare with no saved versions says so", async () => {
  const dir = await tmp();
  const rec = recordingGit((a) => (a[0] === "rev-parse" ? gitError("fatal: bad revision", 128) : ""));
  await assert.rejects(compare({}, { repo: dir, exec: rec.exec, diff: {} as DiffDeps }), VcsUsageError);
});

// ---------- restore ----------

interface Scene {
  dirty?: string[];
  commitError?: Error;
  tree?: string[];
  afterRestore?: string[];
}

function sceneGit(s: Scene) {
  let restored = false;
  return recordingGit((a) => {
    if (a[0] === "rev-parse") return "";
    if (a[0] === "log" && a[1] === "--max-count=1") return LINE("d".repeat(40), "ddddddd", "Before");
    if (a[0] === "log") return LOG;
    if (a[0] === "for-each-ref") return "";
    if (a[0] === "status") return porcelain(...(restored ? (s.afterRestore ?? []) : (s.dirty ?? [])));
    if (a[0] === "commit") return s.commitError;
    if (a[0] === "ls-files") return (s.tree ?? ["a.pen", "assets/x.png"]).filter((p) => a.slice(a.indexOf("--") + 1).some((spec) => spec.startsWith(":(literal)") ? spec.slice(10) === p : p.endsWith(".pen") || p.startsWith("assets/"))).join("\0");
    if (a[0] === "restore") restored = true;
    return "";
  });
}

const repoOf = async (rec: ReturnType<typeof sceneGit>, dir?: string) => createDesignRepo({ repo: dir ?? (await tmp()), exec: rec.exec });
const noBanned = (rec: { subcommands(): string[] }) => {
  for (const b of BANNED) assert.ok(!rec.subcommands().includes(b), b);
};

test("restore on a clean folder: exact argv and summary", async () => {
  const rec = sceneGit({ afterRestore: ["M  a.pen"] });
  const out = await (await repoOf(rec)).restore({ version: "2" });
  assert.deepEqual(rec.calls.slice(-3), [
    [NL, "ls-files", "-z", `--with-tree=${SHA2}`, "--", ...SPECS],
    [NL, "restore", `--source=${SHA2}`, "--worktree", "--", ":(glob)**/*.pen", "assets/"],
    STATUS,
  ]);
  assert.equal(out.restored, true);
  assert.equal(out.summary, "Brought back #2 as 1 unsaved change. Nothing was lost: run design save to keep it as a new version.");
  assert.ok(!rec.subcommands().includes("commit"));
  noBanned(rec);
});

test("restore with nothing differing says so", async () => {
  const rec = sceneGit({});
  const out = await (await repoOf(rec)).restore({ version: "#1" });
  assert.equal(out.restored, false);
  assert.equal(out.summary, "Nothing changed: the files already match #1.");
});

test("restore is refused when there are unsaved changes, and when the only change is an untracked .pen", async () => {
  for (const dirty of [[" M a.pen"], ["?? new.pen"], ["?? assets/n.png"]]) {
    const rec = sceneGit({ dirty });
    await assert.rejects(
      (await repoOf(rec)).restore({ version: "1" }),
      (e: Error) => e instanceof VcsRefusedError && /design save/.test(e.message) && /--save-first/.test(e.message),
    );
    assert.ok(!rec.subcommands().includes("restore"));
    assert.ok(!rec.subcommands().includes("commit"));
  }
});

test("restore --save-first commits 'Before restore to #n' and then restores", async () => {
  const rec = sceneGit({ dirty: [" M a.pen"], afterRestore: ["M  a.pen"] });
  const out = await (await repoOf(rec)).restore({ version: "3", saveFirst: true });
  const subs = rec.subcommands();
  assert.ok(subs.indexOf("commit") < subs.indexOf("restore"));
  assert.deepEqual(rec.calls.find((c) => c[1] === "commit"), [NL, "commit", "--message=Before restore to #3", "--", "a.pen"]);
  assert.ok(rec.calls.some((c) => c[1] === "restore" && c.includes(`--source=${SHA3}`)), "restores the version resolved before saving");
  assert.equal(out.savedFirst?.saved, true);
  assert.match(out.summary, /saved first \(ddddddd\)/);
  assert.equal(subs.filter((s) => s === "commit").length, 1);
  noBanned(rec);
});

test("restore --save-first: a failing save propagates and no restore runs", async () => {
  const rec = sceneGit({ dirty: [" M a.pen"], commitError: gitError("error: gpg failed to sign the data") });
  await assert.rejects((await repoOf(rec)).restore({ version: "1", saveFirst: true }), VcsCommitFailedError);
  assert.ok(!rec.subcommands().includes("restore"));
});

test("restore rejects paths outside the folder and paths with nothing to restore", async () => {
  const dir = await tmp();
  const rec = sceneGit({});
  await assert.rejects((await repoOf(rec, dir)).restore({ version: "1", paths: ["../x.pen"] }), VcsUsageError);
  await assert.rejects(
    (await repoOf(rec, dir)).restore({ version: "1", paths: ["missing.pen"] }),
    (e: Error) => e instanceof VcsRefusedError && /nothing to restore/i.test(e.message),
  );
  assert.ok(!rec.subcommands().includes("restore"));
});

test("restore with user paths uses literal pathspecs; default pathspecs only cover what exists", async () => {
  const rec = sceneGit({});
  await (await repoOf(rec)).restore({ version: "1", paths: ["a.pen"] });
  assert.deepEqual(rec.calls.find((c) => c[1] === "restore"), [NL, "restore", `--source=${SHA1}`, "--worktree", "--", ":(literal)a.pen"]);

  const onlyPen = sceneGit({ tree: ["a.pen"] });
  await (await repoOf(onlyPen)).restore({ version: "1" });
  assert.deepEqual(onlyPen.calls.find((c) => c[1] === "restore")?.slice(-1), [":(glob)**/*.pen"]);

  const empty = sceneGit({ tree: [] });
  await assert.rejects((await repoOf(empty)).restore({ version: "1" }), (e: Error) => e instanceof VcsRefusedError && /nothing to restore/i.test(e.message));
  assert.ok(!empty.subcommands().includes("restore"));
});

// ---------- explore / switch ----------

const exploreGit = (o: { dirty?: boolean; branches?: string[]; current?: string; invalid?: boolean } = {}) =>
  recordingGit((a) => {
    if (a[0] === "for-each-ref") return (o.branches ?? ["main"]).join("\n") + "\n";
    if (a[0] === "branch") return `${o.current ?? "main"}\n`;
    if (a[0] === "status") return o.dirty ? porcelain(" M a.pen") : "";
    if (a[0] === "check-ref-format") return o.invalid ? gitError("", 1) : "";
    return "";
  });

test("explore with a name creates and switches", async () => {
  const rec = exploreGit();
  const out = await (await repoOf(rec)).explore({ name: "bold-colors" });
  assert.deepEqual(rec.calls.map((c) => c.slice(1)), [
    ["check-ref-format", "--branch", "bold-colors"],
    ["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
    STATUS.slice(1),
    ["switch", "-c", "bold-colors"],
    ["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
  ]);
  assert.equal(out.created, true);
  assert.equal(out.summary, 'Started exploration "bold-colors" from the current version and switched to it.');
  noBanned(rec);
});

test("explore lists explorations with the current one marked", async () => {
  const rec = exploreGit({ branches: ["main", "idea"], current: "idea" });
  const out = await (await repoOf(rec)).explore();
  assert.deepEqual(out.explorations, [{ name: "main", current: false }, { name: "idea", current: true }]);
  assert.equal(out.summary, "2 explorations: main, idea (current).");
  assert.ok(!rec.subcommands().includes("switch"));
});

test("explore rejects duplicate, dash-led and invalid names, and refuses when unsaved", async () => {
  await assert.rejects((await repoOf(exploreGit())).explore({ name: "main" }), VcsUsageError);
  const dash = exploreGit();
  await assert.rejects((await repoOf(dash)).explore({ name: "-x" }), VcsUsageError);
  assert.equal(dash.calls.length, 0);
  const bad = exploreGit({ invalid: true });
  await assert.rejects((await repoOf(bad)).explore({ name: "a b" }), VcsUsageError);
  assert.ok(!bad.subcommands().includes("switch"));
  const dirty = exploreGit({ dirty: true });
  await assert.rejects(
    (await repoOf(dirty)).explore({ name: "new" }),
    (e: Error) => e instanceof VcsRefusedError && /design save/.test(e.message),
  );
  assert.ok(!dirty.subcommands().includes("switch"));
});

test("switchTo: ok, already there, dirty refused, unknown, missing main", async () => {
  const ok = exploreGit({ branches: ["main", "idea"], current: "main" });
  const out = await (await repoOf(ok)).switchTo("idea");
  assert.deepEqual(ok.calls.at(-1), [NL, "switch", "--no-guess", "--end-of-options", "idea"]);
  assert.equal(out.summary, 'Switched to exploration "idea".');

  const same = exploreGit({ branches: ["main"], current: "main" });
  assert.equal((await (await repoOf(same)).switchTo("main")).switched, false);
  assert.ok(!same.subcommands().includes("switch"));

  const dirty = exploreGit({ branches: ["main", "idea"], dirty: true });
  await assert.rejects(
    (await repoOf(dirty)).switchTo("idea"),
    (e: Error) => e instanceof VcsRefusedError && /design save/.test(e.message),
  );
  assert.ok(!dirty.subcommands().includes("switch"));

  const unknown = exploreGit({ branches: ["main"] });
  await assert.rejects((await repoOf(unknown)).switchTo("nope"), VcsUsageError);

  const noMain = exploreGit({ branches: ["trunk", "idea"], current: "trunk" });
  await assert.rejects(
    (await repoOf(noMain)).switchTo("main"),
    (e: Error) => e instanceof VcsUsageError && /trunk, idea/.test(e.message),
  );
  assert.ok(!noMain.subcommands().includes("switch"));
});

test("openerFor: win32 uses explorer.exe with the path as one untouched argument", () => {
  const file = "C:\\Design & Brand\\design-diff\\report.html";
  assert.deepEqual(openerFor("win32", file), ["explorer.exe", [file]]);
  assert.deepEqual(openerFor("win32", "C:\\a^b|c\\r.html"), ["explorer.exe", ["C:\\a^b|c\\r.html"]]);
});

test("openerFor: darwin and linux are unchanged", () => {
  assert.deepEqual(openerFor("darwin", "/x/r.html"), ["open", ["/x/r.html"]]);
  assert.deepEqual(openerFor("linux", "/x/r.html"), ["xdg-open", ["/x/r.html"]]);
});
