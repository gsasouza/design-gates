import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createDesignRepo,
  getUnsavedChanges,
  createSafeGit,
  VcsCommitFailedError,
  VcsRefusedError,
  VcsUsageError,
} from "../src/index.js";
import { gitError, porcelain, recordingGit } from "./vcs-helpers.js";

const NO_LOCKS = "--no-optional-locks";
const SPECS = [":(glob)**/*.pen", ":(glob)**/*.fig", ":(glob)assets/**"];
const STATUS = [NO_LOCKS, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...SPECS];
const LOG_LINE = (sha: string, short: string, msg: string) => `${sha}\x1f${short}\x1f${msg}\n`;
const SHA1 = "a".repeat(40);

async function tmp() {
  return mkdtemp(path.join(os.tmpdir(), "vcs-unit-"));
}

test("init in a fresh folder: exact argv and summary", async () => {
  const dir = await tmp();
  let inited = false;
  const rec = recordingGit((a) => {
    if (a[0] === "rev-parse" && a[1] === "--show-toplevel") return inited ? dir : gitError("fatal: not a git repository", 128);
    if (a[0] === "init") inited = true;
    if (a[0] === "config" && a[1] === "--get") return gitError("", 1);
    if (a[0] === "status") return porcelain("?? a.pen", "?? assets/x.png");
    if (a[0] === "log") return LOG_LINE(SHA1, "aaaaaaa", "First version");
    return undefined;
  });
  const repo = createDesignRepo({ repo: dir, exec: rec.exec });
  const r = await repo.init();
  assert.deepEqual(rec.calls, [
    [NO_LOCKS, "rev-parse", "--show-toplevel"],
    [NO_LOCKS, "init", "--initial-branch=main"],
    [NO_LOCKS, "config", "--get", "user.name"],
    [NO_LOCKS, "config", "--local", "user.name", "Designer"],
    [NO_LOCKS, "config", "--get", "user.email"],
    [NO_LOCKS, "config", "--local", "user.email", "designer@localhost"],
    STATUS,
    [NO_LOCKS, "add", "--", ":(literal)a.pen", ":(literal)assets/x.png"],
    [NO_LOCKS, "commit", "--message=First version", "--", ":(literal)a.pen", ":(literal)assets/x.png"],
    [NO_LOCKS, "log", "--max-count=1", "--format=%H%x1f%h%x1f%s"],
  ]);
  assert.equal(await readFile(path.join(dir, ".gitignore"), "utf8"), "/design-diff/\n");
  assert.equal(r.changed, true);
  assert.equal(
    r.summary,
    'Started tracking versions in this folder. Report output (design-diff) is now left out of versions. Set a local name/email for saving (user.name, user.email). Saved the existing designs as "First version" (aaaaaaa).',
  );
});

test("init on an existing repo with identity set and gitignore present changes nothing", async () => {
  const dir = await tmp();
  await writeFile(path.join(dir, ".gitignore"), "node_modules\n/design-diff/\n");
  const rec = recordingGit((a) => (a[0] === "rev-parse" ? dir : undefined));
  const r = await createDesignRepo({ repo: dir, exec: rec.exec }).init();
  assert.deepEqual(rec.calls, [
    [NO_LOCKS, "rev-parse", "--show-toplevel"],
    [NO_LOCKS, "config", "--get", "user.name"],
    [NO_LOCKS, "config", "--get", "user.email"],
    STATUS,
  ]);
  assert.equal(r.changed, false);
  assert.equal(r.summary, "Nothing changed: this folder is already set up for versions.");
  assert.equal(await readFile(path.join(dir, ".gitignore"), "utf8"), "node_modules\n/design-diff/\n");
});

test("init refuses to write through a .gitignore symlink", async () => {
  const dir = await tmp();
  const target = path.join(await tmp(), "elsewhere");
  await writeFile(target, "keep\n");
  await symlink(target, path.join(dir, ".gitignore"));
  const rec = recordingGit((a) => (a[0] === "rev-parse" ? dir : undefined));
  await assert.rejects(createDesignRepo({ repo: dir, exec: rec.exec }).init(), VcsRefusedError);
  assert.equal(await readFile(target, "utf8"), "keep\n");
});

test("init extends a .gitignore without trailing newline, once", async () => {
  const dir = await tmp();
  await writeFile(path.join(dir, ".gitignore"), "dist");
  const rec = recordingGit((a) => (a[0] === "rev-parse" ? dir : undefined));
  const repo = createDesignRepo({ repo: dir, exec: rec.exec });
  await repo.init();
  await repo.init();
  assert.equal(await readFile(path.join(dir, ".gitignore"), "utf8"), "dist\n/design-diff/\n");
});

test("init sets only the identity key that is unset", async () => {
  const dir = await tmp();
  const rec = recordingGit((a) => {
    if (a[0] === "rev-parse") return dir;
    if (a[0] === "config" && a[1] === "--get" && a[2] === "user.email") return gitError("", 1);
    return undefined;
  });
  const r = await createDesignRepo({ repo: dir, exec: rec.exec }).init();
  assert.deepEqual(r.identitySet, ["user.email"]);
  assert.ok(rec.calls.some((c) => c.join(" ") === `${NO_LOCKS} config --local user.email designer@localhost`));
  assert.ok(!rec.calls.some((c) => c.includes("user.name") && c.includes("--local")));
});

test("init inside an enclosing repo is refused and writes nothing", async () => {
  const outer = await tmp();
  const dir = path.join(outer, "inner");
  await (await import("node:fs/promises")).mkdir(dir);
  const rec = recordingGit((a) => (a[0] === "rev-parse" ? outer : undefined));
  await assert.rejects(createDesignRepo({ repo: dir, exec: rec.exec }).init(), (e) => {
    assert.ok(e instanceof VcsRefusedError);
    assert.equal(e.exitCode, 1);
    assert.match(e.message, /inside another project's history/);
    return true;
  });
  assert.equal(rec.calls.length, 1);
});

test("status lists new/changed/deleted and the exploration", async () => {
  const dir = await tmp();
  const rec = recordingGit((a) => {
    if (a[0] === "status") return porcelain("?? new.pen", " M old.pen", " D gone.pen", "R  moved.pen", "before.pen");
    if (a[0] === "branch") return "main\n";
    return undefined;
  });
  const r = await createDesignRepo({ repo: dir, exec: rec.exec }).status();
  assert.deepEqual(r.files, [
    { path: "new.pen", state: "new" },
    { path: "old.pen", state: "changed" },
    { path: "gone.pen", state: "deleted" },
    { path: "moved.pen", state: "changed", oldPath: "before.pen" },
  ]);
  assert.equal(r.exploration, "main");
  assert.equal(r.clean, false);
  assert.equal(
    r.summary,
    '4 unsaved changes on exploration "main": new.pen (new), old.pen (changed), gone.pen (deleted), moved.pen (changed).',
  );
  assert.deepEqual(rec.calls[1], [NO_LOCKS, "branch", "--show-current"]);
});

test("save: explicit message, pathspecs only (no add -A)", async () => {
  const dir = await tmp();
  const rec = recordingGit((a) => {
    if (a[0] === "status") return porcelain(" M a.pen", "?? sub/b.pen");
    if (a[0] === "log") return LOG_LINE(SHA1, "aaaaaaa", "Tweak");
    return undefined;
  });
  const r = await createDesignRepo({ repo: dir, exec: rec.exec }).save({ message: "Tweak" });
  assert.deepEqual(rec.calls.slice(1), [
    [NO_LOCKS, "add", "--", ":(literal)a.pen", ":(literal)sub/b.pen"],
    [NO_LOCKS, "commit", "--message=Tweak", "--", ":(literal)a.pen", ":(literal)sub/b.pen"],
    [NO_LOCKS, "log", "--max-count=1", "--format=%H%x1f%h%x1f%s"],
  ]);
  assert.equal(r.summary, "Saved a new version (aaaaaaa): Tweak. 2 files included.");
  assert.deepEqual(r.version, { sha: SHA1, shortId: "aaaaaaa" });
});

test("save: messages that look like flags or forbidden words are accepted", async () => {
  for (const message of ["reset", "-f", "push", "--hard"]) {
    const rec = recordingGit((a) => (a[0] === "status" ? porcelain(" M a.pen") : a[0] === "log" ? LOG_LINE(SHA1, "aaaaaaa", message) : undefined));
    await createDesignRepo({ repo: await tmp(), exec: rec.exec }).save({ message });
    assert.deepEqual(rec.calls[2], [NO_LOCKS, "commit", `--message=${message}`, "--", ":(literal)a.pen"]);
  }
});

test("save: files named like forbidden words are accepted after --", async () => {
  const rec = recordingGit((a) => (a[0] === "status" ? porcelain(" M push.pen", " M clean.pen") : a[0] === "log" ? LOG_LINE(SHA1, "aaaaaaa", "x") : undefined));
  await createDesignRepo({ repo: await tmp(), exec: rec.exec }).save({ message: "x" });
  assert.deepEqual(rec.calls[1], [NO_LOCKS, "add", "--", ":(literal)push.pen", ":(literal)clean.pen"]);
});

test("save: default message comes from the injected local clock", async () => {
  const rec = recordingGit((a) => (a[0] === "status" ? porcelain(" M a.pen") : a[0] === "log" ? LOG_LINE(SHA1, "aaaaaaa", "x") : undefined));
  const repo = createDesignRepo({ repo: await tmp(), exec: rec.exec, clock: () => new Date(2026, 0, 2, 3, 4) });
  const r = await repo.save();
  assert.equal(r.message, "Saved 2026-01-02 03:04");
  assert.deepEqual(rec.calls[2], [NO_LOCKS, "commit", "--message=Saved 2026-01-02 03:04", "--", ":(literal)a.pen"]);
});

test("save: nothing changed makes no commit call and is not an error", async () => {
  const rec = recordingGit(() => "");
  const r = await createDesignRepo({ repo: await tmp(), exec: rec.exec }).save();
  assert.equal(r.saved, false);
  assert.equal(r.summary, "Nothing to save: no design changes since the last version.");
  assert.deepEqual(rec.subcommands(), ["status"]);
});

const SIGN_STDERR = "error: gpg failed to sign the data\nfatal: failed to write commit object\n";
const failCases: [string, string, string, string][] = [
  ["signing", SIGN_STDERR, "Saving failed because your git setup signs versions and signing failed: error: gpg failed to sign the data", "signing"],
  ["cannot run gpg", "error: cannot run gpg: No such file or directory\n", "Saving failed because your git setup signs versions and signing failed: error: cannot run gpg: No such file or directory", "signing"],
  // The hook branch only fires when the hook's own output mentions "hook" (real git adds no preamble; see vcs-real-git.test.ts).
  ["hook", "pre-commit hook: lint failed\n", "Saving failed because a git hook rejected it: pre-commit hook: lint failed", "hook"],
  ["unknown", "\nfatal: something odd\nmore\n", "Saving failed: fatal: something odd", "other"],
];

for (const [name, stderr, message, cause] of failCases) {
  test(`commit failure (${name}): save and init stop with no further git calls`, async () => {
    for (const via of ["save", "init"] as const) {
      const dir = await tmp();
      const rec = recordingGit((a) => {
        if (a[0] === "rev-parse") return dir;
        if (a[0] === "status") return porcelain("?? a.pen");
        if (a[0] === "commit") return gitError(stderr);
        return undefined;
      });
      const repo = createDesignRepo({ repo: dir, exec: rec.exec });
      await assert.rejects(via === "save" ? repo.save({ message: "m" }) : repo.init(), (e) => {
        assert.ok(e instanceof VcsCommitFailedError);
        assert.equal(e.exitCode, 1);
        assert.equal(e.message, message);
        assert.equal(e.reason, cause);
        return true;
      });
      assert.equal(rec.subcommands().at(-1), "commit");
      assert.equal(rec.subcommands().filter((s) => s === "commit").length, 1);
    }
  });
}

test("commit failure without stderr property uses the message minus the Command failed line", async () => {
  const rec = recordingGit((a) => (a[0] === "status" ? porcelain("?? a.pen") : a[0] === "commit" ? new Error("Command failed: git commit\nfatal: boom\n") : undefined));
  await assert.rejects(createDesignRepo({ repo: await tmp(), exec: rec.exec }).save({ message: "m" }), /^VcsCommitFailedError: Saving failed: fatal: boom$/);
});

test("unsaved-changes helper", async () => {
  const cases: [string, string, boolean][] = [
    ["clean", "", false],
    ["modified tracked", porcelain(" M a.pen"), true],
    ["staged", porcelain("M  a.pen"), true],
    ["untracked .pen", porcelain("?? new.pen"), true],
    ["untracked asset", porcelain("?? assets/p.png"), true],
    ["untracked non-.pen outside assets", porcelain("?? notes.txt"), false],
  ];
  for (const [name, out, expected] of cases) {
    const r = await getUnsavedChanges(createSafeGit(recordingGit(() => out).exec));
    assert.equal(r.unsaved, expected, name);
  }
});

test("history without file, with limit, and with file", async () => {
  const dir = await tmp();
  const entry = (sha: string, short: string, msg: string, ...files: string[]) =>
    `\x1e${sha}\x1f${short}\x1f2026-01-02T03:04:05+00:00\x1f${msg}\0\n${files.map((f) => `${f}\0`).join("")}`;
  const s = (c: string) => c.repeat(40);
  const rec = recordingGit((a) => {
    if (a[0] === "branch") return "main\n";
    if (a[0] === "log" && a[1] === "--format=%H%x1f%h%x1f%s") return LOG_LINE(s("c"), "ccccccc", "three") + LOG_LINE(s("b"), "bbbbbbb", "two") + LOG_LINE(s("a"), "aaaaaaa", "one");
    if (a[0] === "log" && a.includes("--follow")) return entry(s("c"), "ccccccc", "three", "x.pen") + entry(s("a"), "aaaaaaa", "one", "old.pen");
    if (a[0] === "log") return entry(s("c"), "ccccccc", "three", "x.pen") + entry(s("b"), "bbbbbbb", "two", "y.pen", "z.pen");
    return undefined;
  });
  const repo = createDesignRepo({ repo: dir, exec: rec.exec });
  const all = await repo.history({ limit: 2 });
  assert.deepEqual(all.versions.map((v) => [v.number, v.shortId, v.message, v.files]), [
    [1, "ccccccc", "three", ["x.pen"]],
    [2, "bbbbbbb", "two", ["y.pen", "z.pen"]],
  ]);
  assert.equal(all.versions[0].date, "2026-01-02T03:04:05+00:00");
  assert.ok(rec.calls.some((c) => c.join(" ") === `${NO_LOCKS} log -z --name-only --max-count=2 --format=%x1e%H%x1f%h%x1f%aI%x1f%s`));
  const filtered = await repo.history({ file: "x.pen" });
  assert.deepEqual(filtered.versions.map((v) => v.number), [1, 3]);
  assert.deepEqual(rec.calls.at(-1)?.slice(-3), ["--follow", "--", "x.pen"]);
  await assert.rejects(repo.history({ file: "../out.pen" }), VcsUsageError);
  await assert.rejects(repo.history({ limit: 0 }), VcsUsageError);
});

test("init with only added-then-deleted entries saves nothing and reports no first version", async () => {
  const dir = await tmp();
  const rec = recordingGit((a) => {
    if (a[0] === "rev-parse") return dir;
    if (a[0] === "status") return porcelain("AD gone.pen");
    return undefined;
  });
  const r = await createDesignRepo({ repo: dir, exec: rec.exec }).init();
  assert.equal(r.saved, null);
  assert.ok(!rec.calls.some((c) => c.includes("commit")));
  assert.ok(!r.summary.includes("First version"));
});

test("save summary and files count only committed entries, not added-then-deleted", async () => {
  const dir = await tmp();
  const rec = recordingGit((a) => {
    if (a[0] === "rev-parse") return dir;
    if (a[0] === "status") return porcelain("?? a.pen", "AD gone.pen");
    if (a[0] === "log") return LOG_LINE(SHA1, "aaaaaaa", "msg");
    return undefined;
  });
  const r = await createDesignRepo({ repo: dir, exec: rec.exec }).save({ message: "msg" });
  assert.equal(r.saved, true);
  assert.deepEqual(r.files.map((f) => f.path), ["a.pen"]);
  assert.ok(r.summary.includes("1 file included"), r.summary);
});
