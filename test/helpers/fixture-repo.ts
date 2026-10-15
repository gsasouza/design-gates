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

/**
 * Creates a throwaway git repo on branch `main`: commit 1 = `fixtures/base`
 * (tag `base`), commit 2 = `fixtures/head` replacing the whole tree (tag `head`).
 */
export async function createFixtureRepo(): Promise<FixtureRepo> {
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
    await cp(fileURLToPath(fixtureUrl(`${side}/`)), dir, { recursive: true });
  };
  try {
    await git("init", "-b", "main");
    await replaceTree("base");
    await git("add", "-A");
    await git("commit", "-m", "base");
    await git("tag", "base");
    await replaceTree("head");
    await git("add", "-A");
    await git("commit", "-m", "head");
    await git("tag", "head");
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  return { path: dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
