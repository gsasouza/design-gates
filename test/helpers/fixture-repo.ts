import { execFile } from "node:child_process";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { fixtureUrl } from "./fixtures.js";

const run = promisify(execFile);

const IDENTITY = {
  GIT_AUTHOR_NAME: "Fixture Author",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_AUTHOR_DATE: "2024-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "Fixture Author",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_COMMITTER_DATE: "2024-01-01T00:00:00Z",
};

export interface FixtureRepo {
  path: string;
  cleanup: () => Promise<void>;
}

export interface FixtureRepoOptions {
  /** Directory under `fixtures/` for commit 1 (default `base`). */
  base?: string;
  /** Directory under `fixtures/` for commit 2 (default `head`). */
  head?: string;
  /** Commits one file per side instead of a whole tree: fixture paths `base` and `head` are stored as `as`. */
  single?: { base: string; head: string; as: string };
}

/**
 * Creates a throwaway git repo on branch `main`: commit 1 = `fixtures/base`
 * (tag `base`), commit 2 = `fixtures/head` replacing the whole tree (tag `head`).
 * `opts` picks other fixture directories for either commit.
 */
export async function createFixtureRepo(opts: FixtureRepoOptions = {}): Promise<FixtureRepo> {
  const dir = await mkdtemp(path.join(tmpdir(), "design-gates-"));
  const git = async (...args: string[]): Promise<void> => {
    await run(
      "git",
      [
        "--no-optional-locks",
        "-c", "commit.gpgsign=false",
        "-c", "core.autocrlf=false",
        "-c", "core.hooksPath=/dev/null",
        ...args,
      ],
      {
        cwd: dir,
        env: {
          ...process.env,
          ...IDENTITY,
          GIT_CONFIG_GLOBAL: devNull,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_OPTIONAL_LOCKS: "0",
        },
        maxBuffer: 256 * 1024 * 1024,
      },
    );
  };
  const replaceTree = async (side: string): Promise<void> => {
    for (const entry of await readdir(dir)) {
      if (entry !== ".git") await rm(path.join(dir, entry), { recursive: true, force: true });
    }
    if (opts.single) {
      const from = side === "base" ? opts.single.base : opts.single.head;
      await cp(fileURLToPath(fixtureUrl(from)), path.join(dir, opts.single.as));
      return;
    }
    await cp(fileURLToPath(fixtureUrl(`${side}/`)), dir, { recursive: true });
  };
  try {
    await git("init", "-b", "main");
    await replaceTree(opts.single ? "base" : (opts.base ?? "base"));
    await git("add", "-A");
    await git("commit", "-m", "base");
    await git("tag", "base");
    await replaceTree(opts.single ? "head" : (opts.head ?? "head"));
    await git("add", "-A");
    await git("commit", "-m", "head");
    await git("tag", "head");
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  return { path: dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
