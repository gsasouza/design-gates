import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ALLOWED_GIT_SUBCOMMANDS, createDesignRepo, createSafeGit, resolveRepoPath, VcsUsageError } from "../src/index.js";
import { gitError, porcelain, recordingGit } from "./vcs-helpers.js";

test("allowlist is an exact, deliberate list", () => {
  assert.deepEqual(
    [...ALLOWED_GIT_SUBCOMMANDS],
    ["init", "rev-parse", "config", "status", "add", "commit", "log", "diff", "ls-files", "show", "branch", "for-each-ref", "restore", "switch"],
  );
});

test("wrapper rejects forbidden subcommands and flags before executing", async () => {
  const rec = recordingGit(() => "");
  const git = createSafeGit(rec.exec);
  const bad: string[][] = [
    ["push"], ["clean", "-n"], ["reset"], ["rebase"], ["checkout", "main"], ["fetch"], ["pull"], ["merge"],
    ["config", "--global", "user.name", "x"], ["config", "--system", "user.name", "x"], ["config", "--file", "x", "--get", "a"],
    ["config", "--file=x", "--get", "a"], ["config", "user.name", "x"],
    ["add", "--force", "a.pen"], ["add", "-f", "a.pen"], ["add", "-fv", "a.pen"], ["branch", "-D", "x"], ["branch", "-Df", "x"],
    ["restore", "--hard"], ["branch", "--delete", "x"], ["branch", "-d", "x"], ["switch", "--force", "x"], ["status", "--global"],
    ["switch", "-C", "x"], ["switch", "--force-create", "x"], ["switch", "--discard-changes", "x"], ["switch", "--orphan", "x"],
    ["switch", "-cC", "x"],
    ["branch", "-M", "x"], ["branch", "-C", "a", "b"], ["branch", "--move", "a", "b"], ["branch", "--copy", "a", "b"],
    ["branch", "-m", "a", "b"], ["branch", "-c", "a", "b"], ["branch", "-vM", "a", "b"],
    ["switch", "--orph", "x"], ["switch", "--discard", "x"], ["switch", "--orphan=x"], ["switch", "--force-create=x"],
    ["branch", "--mov", "a", "b"], ["branch", "--del", "x"], ["config", "--glob", "user.name"],
    ["commit", "--amend", "--message=x"], ["diff", "--output=/tmp/x"],
    [],
  ];
  for (const args of bad) await assert.rejects(git(args), Error, args.join(" "));
  assert.equal(rec.calls.length, 0);
});

test("wrapper allows forbidden words and flags after the end of options", async () => {
  const rec = recordingGit(() => "");
  const git = createSafeGit(rec.exec);
  await git(["add", "--", "push", "-f", "reset"]);
  await git(["rev-parse", "--verify", "--end-of-options", "-f"]);
  await git(["commit", "--message=-f", "--", "clean.pen"]);
  await git(["config", "--local", "user.name", "reset"]);
  await git(["config", "--get", "user.name"]);
  await git(["log", "--max-count=1"]);
  await git(["commit", "--message=x", "--", "a.pen"]);
  assert.equal(rec.calls.length, 7);
});

test("every vcs method issues only allowed subcommands, never --global/--system", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vcs-safety-"));
  const rec = recordingGit((a) => {
    if (a[0] === "rev-parse" && a[1] === "--show-toplevel") return gitError("fatal: not a git repository", 128);
    if (a[0] === "config" && a[1] === "--get") return gitError("", 1);
    if (a[0] === "status") return porcelain("?? a.pen");
    if (a[0] === "log") return `${"a".repeat(40)}\x1faaaaaaa\x1fm\n`;
    return undefined;
  });
  const repo = createDesignRepo({ repo: dir, exec: rec.exec });
  await repo.init();
  await repo.status();
  await repo.save({ message: "m" });
  await repo.history({ file: "a.pen", limit: 3 });
  await repo.unsavedChanges();
  await repo.resolveVersion("main").catch(() => undefined);
  await repo.resolveVersion("#1");
  await repo.resolveVersion("aaaa").catch(() => undefined);
  assert.ok(rec.calls.length > 10);
  for (const call of rec.calls) {
    assert.equal(call[0], "--no-optional-locks");
    assert.ok((ALLOWED_GIT_SUBCOMMANDS as readonly string[]).includes(call[1]), call.join(" "));
    assert.ok(!call.includes("--global") && !call.includes("--system"), call.join(" "));
  }
});

test("resolveRepoPath: inside, escaping, option-like and empty paths", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vcs-paths-"));
  assert.equal(await resolveRepoPath(dir, "a/b.pen"), "a/b.pen");
  assert.equal(await resolveRepoPath(dir, path.join(dir, "x.pen")), "x.pen");
  for (const bad of ["../x.pen", "/etc/passwd", "a/../../x", "", "-x.pen", "."]) {
    await assert.rejects(resolveRepoPath(dir, bad), VcsUsageError, bad);
  }
});
