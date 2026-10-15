import { execFile } from "node:child_process";
import { constants } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { computeSemanticDiffWithDocs } from "../diff/compute.js";
import type { DiffResult } from "../diff/model.js";
import { serializeDiff } from "../diff/serialize.js";
import type { GitReader } from "../git/reader.js";
import { createOpenPencilRenderer } from "../render/openpencil.js";
import type { Renderer } from "../render/renderer.js";
import { renderReport } from "../report/render-report.js";
import { computeVisualDiff } from "../visual/compute.js";

export interface DiffOptions {
  repo?: string;
  base?: string;
  head?: string;
  out?: string;
  threshold?: number;
  scale?: number;
  inline?: boolean;
  paths?: string[];
}

/** The file system operations runDiff needs; tests inject an in-memory fake. */
export interface RunFs {
  mkdir(dir: string, opts: { recursive: true }): Promise<unknown>;
  mkdtemp(prefix: string): Promise<string>;
  writeFile(file: string, data: string | Uint8Array): Promise<void>;
  readFile(file: string): Promise<Uint8Array>;
  rm(target: string, opts: { recursive: true; force: true }): Promise<void>;
  cp(from: string, to: string, opts: { recursive: true }): Promise<void>;
  realpath(target: string): Promise<string>;
  exists(target: string): Promise<boolean>;
  /** True when `target` itself (not its destination) is a symbolic link. */
  isSymlink(target: string): Promise<boolean>;
  /** Relative `/`-separated paths of every file below `dir`. */
  listFiles(dir: string): Promise<string[]>;
}

export interface DiffDeps {
  cwd: string;
  tmpdir: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fs: RunFs;
  /** Absolute git directories (`--absolute-git-dir`, `--git-common-dir`) of the repo; throws when it is not a repo. */
  gitDirs: (repo: string) => Promise<string[]>;
  git?: GitReader;
  createRenderer: (scale: number) => Renderer;
}

export class UsageError extends Error {}

export const defaultFs: RunFs = {
  mkdir: (dir, opts) => nodeFs.mkdir(dir, opts),
  mkdtemp: (prefix) => nodeFs.mkdtemp(prefix),
  writeFile: (file, data) =>
    nodeFs.writeFile(file, data, { flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW }),
  readFile: (file) => nodeFs.readFile(file),
  rm: (target, opts) => nodeFs.rm(target, opts),
  cp: (from, to, opts) => nodeFs.cp(from, to, opts),
  realpath: (target) => nodeFs.realpath(target),
  exists: (target) => nodeFs.access(target).then(() => true, () => false),
  isSymlink: (target) => nodeFs.lstat(target).then((st) => st.isSymbolicLink(), () => false),
  listFiles: async (dir) =>
    (await nodeFs.readdir(dir, { recursive: true, withFileTypes: true }))
      .filter((e) => e.isFile())
      .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join("/")),
};

function gitOut(repo: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["--no-optional-locks", ...args], { cwd: repo, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout.trim());
    });
  });
}

export async function gitDirsOf(repo: string): Promise<string[]> {
  try {
    const dir = await gitOut(repo, ["rev-parse", "--absolute-git-dir"]);
    const common = await gitOut(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    return [dir, common];
  } catch {
    throw new Error(`Not a git repository: ${repo}`);
  }
}

export function defaultDeps(): DiffDeps {
  return {
    cwd: process.cwd(),
    tmpdir: tmpdir(),
    stdout: (t) => void process.stdout.write(t),
    stderr: (t) => void process.stderr.write(t),
    fs: defaultFs,
    gitDirs: gitDirsOf,
    createRenderer: (scale) => createOpenPencilRenderer({ scale }),
  };
}

const isInside = (parent: string, child: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** Real path of the deepest existing ancestor of `target`, with the missing tail re-appended. */
async function realOrAncestor(fs: RunFs, target: string): Promise<string> {
  const tail: string[] = [];
  let cur = path.resolve(target);
  for (;;) {
    try {
      return path.join(await fs.realpath(cur), ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(target);
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** Refuses to write through a symlink planted at any of `targets` (the output tree may come from an untrusted worktree). */
async function refuseSymlinks(fs: RunFs, targets: string[]): Promise<void> {
  for (const target of targets) {
    if (await fs.isSymlink(target)) throw new Error(`Refusing to write through a symlink: ${target}`);
  }
}

/** Refuses when `out` or any existing component between `base` and `out` is a symlink. */
async function refuseSymlinkedOut(fs: RunFs, base: string, out: string): Promise<void> {
  const rel = path.relative(base, out);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return;
  let cur = base;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    if (await fs.isSymlink(cur)) throw new Error(`Refusing to write through a symlink: ${cur}`);
  }
}

function validate(o: DiffOptions): void {
  if (o.threshold !== undefined && !(Number.isFinite(o.threshold) && o.threshold >= 0 && o.threshold <= 1)) {
    throw new UsageError(`--threshold must be a number between 0 and 1, got ${o.threshold}`);
  }
  if (o.scale !== undefined && !(Number.isFinite(o.scale) && o.scale > 0 && o.scale <= 8)) {
    throw new UsageError(`--scale must be a number greater than 0 and at most 8, got ${o.scale}`);
  }
  for (const [flag, value] of [["--base", o.base], ["--head", o.head]] as const) {
    if (value !== undefined && (value === "" || value.startsWith("-"))) {
      throw new UsageError(`${flag} must be a git ref, got "${value}"`);
    }
  }
}

export async function buildDiffReport(o: DiffOptions, deps: DiffDeps): Promise<{ result: DiffResult; out: string }> {
  const { fs } = deps;
  const repo = path.resolve(deps.cwd, o.repo ?? ".");
  const out = path.resolve(deps.cwd, o.out ?? "design-diff");
  const gitDirs = await deps.gitDirs(repo);
  const realOut = await realOrAncestor(fs, out);
  for (const dir of gitDirs) {
    if (isInside(await realOrAncestor(fs, dir), realOut)) {
      throw new Error(`Refusing to write into the git directory: --out ${out} is inside ${dir}`);
    }
  }

  // An absolute --out outside the repo was chosen explicitly by the user; anything else may come from the worktree.
  const explicit = o.out !== undefined && path.isAbsolute(o.out) && !isInside(repo, out);
  if (!explicit) await refuseSymlinkedOut(fs, isInside(repo, out) ? repo : deps.cwd, out);

  const tmp = await fs.mkdtemp(path.join(deps.tmpdir, "design-gates-"));
  try {
    const { result, docs } = await computeSemanticDiffWithDocs({
      repo,
      ...(o.base !== undefined && { base: o.base }),
      ...(o.head !== undefined && { head: o.head }),
      paths: o.paths ?? [],
      ...(deps.git && { git: deps.git }),
    });
    await computeVisualDiff({
      result,
      docs,
      renderer: deps.createRenderer(o.scale ?? 1),
      outDir: tmp,
      scale: o.scale ?? 1,
      ...(o.threshold !== undefined && { threshold: o.threshold }),
      fs: { mkdir: (d, op) => fs.mkdir(d, op), writeFile: (f, d) => fs.writeFile(f, d) },
    });

    const images = new Map<string, Uint8Array>();
    if (await fs.exists(path.join(tmp, "images"))) {
      for (const rel of await fs.listFiles(path.join(tmp, "images"))) {
        images.set(`images/${rel}`, await fs.readFile(path.join(tmp, "images", ...rel.split("/"))));
      }
    }
    const html = renderReport(result, { inline: o.inline === true, imageReader: (rel) => images.get(rel) });

    // `<out>/images` is only replaced when a previous run's diff.json proves it is ours.
    const sorted = [...images].sort(([a], [b]) => (a < b ? -1 : 1));
    const dirs = new Set(sorted.flatMap(([rel]) => ["images", path.posix.dirname(rel)]));
    await refuseSymlinks(fs, [
      ...[...dirs].sort().map((d) => path.join(out, ...d.split("/"))),
      ...sorted.map(([rel]) => path.join(out, ...rel.split("/"))),
      path.join(out, "diff.json"),
      path.join(out, "report.html"),
    ]);
    await fs.mkdir(out, { recursive: true });
    if (await fs.exists(path.join(out, "diff.json"))) await fs.rm(path.join(out, "images"), { recursive: true, force: true });
    for (const [rel, data] of sorted) {
      await fs.mkdir(path.dirname(path.join(out, rel)), { recursive: true });
      await fs.writeFile(path.join(out, rel), data);
    }
    await fs.writeFile(path.join(out, "diff.json"), serializeDiff(result));
    await fs.writeFile(path.join(out, "report.html"), html);
    return { result, out };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/** Runs `design-gates diff`; resolves to the process exit code (0 unless an error occurred). */
export async function runDiff(options: DiffOptions, deps: DiffDeps = defaultDeps()): Promise<number> {
  try {
    validate(options);
    const { result, out } = await buildDiffReport(options, deps);
    const frames = result.files.flatMap((f) => f.frames);
    const changes = frames.reduce((n, f) => n + f.nodes.length, 0);
    deps.stdout(
      `${result.files.length} file(s), ${frames.length} frame(s), ${changes} change(s)\n` +
        `Report: ${path.join(out, "report.html")}\n`,
    );
    return 0;
  } catch (err) {
    deps.stderr(`design-gates: ${err instanceof Error ? err.message : String(err)}\n`);
    return err instanceof UsageError ? 2 : 1;
  }
}
