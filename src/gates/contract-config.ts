/** The optional top-level `contract` config key: where the repo files outside the .pen documents live. */
export interface TokenSourceConfig {
  kind: "css" | "dtcg";
  /** Repo-relative POSIX path: the CSS file, or the DTCG JSON for the default theme. */
  path: string;
  /** css only: selectors whose declarations form the default theme; defaults to `:root`. */
  selectors?: string[];
  /** Theme key (`axis=value[,axis=value]`, axes sorted) -> a CSS selector (css) or a DTCG file path (dtcg). */
  themes?: Record<string, string>;
}

export interface ContractConfig {
  /** Repo-relative path of the component id -> code path map. */
  mapFile: string;
  tokenSource?: TokenSourceConfig;
  /** Globs of code files, used by DIF-003. */
  codeGlobs: string[];
}

export const DEFAULT_CONTRACT: ContractConfig = { mapFile: "pen-map.json", codeGlobs: [] };

type Check = (value: unknown) => string | undefined;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** True for a non-empty repo-relative POSIX path with no `..` segment (not absolute, no backslash). */
export function isRepoRelativePath(p: string): boolean {
  if (p === "" || p.startsWith("/") || p.includes("\\") || /^[A-Za-z]:/.test(p) || p.includes("\0")) return false;
  return !p.split("/").includes("..");
}

const PATH_PROBLEM = "must be a non-empty repo-relative path without ..";
const repoPath: Check = (v) => (typeof v === "string" && isRepoRelativePath(v) ? undefined : PATH_PROBLEM);

const codeGlobs: Check = (v) =>
  Array.isArray(v) && v.every((g) => typeof g === "string" && isRepoRelativePath(g) && !g.startsWith(":"))
    ? undefined
    : "must be an array of non-empty repo-relative globs without .. that do not start with :";

const selectors: Check = (v) =>
  Array.isArray(v) && v.every((s) => typeof s === "string" && s.trim() !== "") ? undefined : "must be an array of non-empty strings";

/** `axis=value[,axis=value]` with the axes unique and sorted, like CompiledNode.themeKey; so neither "" nor "default" qualifies. */
function isThemeKey(key: string): boolean {
  const axes: string[] = [];
  for (const part of key.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 1 || eq === part.length - 1) return false;
    axes.push(part.slice(0, eq));
  }
  return axes.every((a, i) => i === 0 || axes[i - 1]! < a);
}

const TOKEN_SOURCE_KEYS = ["kind", "path", "selectors", "themes"];

function tokenSource(v: unknown): string | undefined {
  if (!isObject(v)) return "must be an object";
  for (const key of Object.keys(v)) if (!TOKEN_SOURCE_KEYS.includes(key)) return `has an unknown key "${key}"`;
  if (v.kind !== "css" && v.kind !== "dtcg") return "kind must be one of css, dtcg";
  const path = repoPath(v.path);
  if (path) return `path ${path}`;
  if (v.selectors !== undefined) {
    if (v.kind !== "css") return "selectors is only valid for kind css";
    const problem = selectors(v.selectors);
    if (problem) return `selectors ${problem}`;
  }
  if (v.themes !== undefined) {
    if (!isObject(v.themes)) return "themes must be an object mapping a theme key to a " + (v.kind === "css" ? "selector" : "file path");
    for (const [key, value] of Object.entries(v.themes)) {
      if (!isThemeKey(key)) return `themes key "${key}" must be sorted axis=value pairs joined by commas, such as mode=dark`;
      if (v.kind === "css" ? typeof value !== "string" || value.trim() === "" : repoPath(value)) {
        return v.kind === "css" ? `themes["${key}"] must be a non-empty selector` : `themes["${key}"] ${PATH_PROBLEM}`;
      }
    }
  }
  return undefined;
}

const CONTRACT_CHECKS: Record<string, Check> = {
  mapFile: repoPath,
  codeGlobs,
};

/** Validate the `contract` key and fill in defaults. */
export function resolveContract(raw: unknown): { contract: ContractConfig } | { error: string } {
  if (!isObject(raw)) return { error: "contract must be an object" };
  const contract: ContractConfig = structuredClone(DEFAULT_CONTRACT);
  for (const [key, value] of Object.entries(raw)) {
    if (key === "tokenSource") {
      const problem = tokenSource(value);
      if (problem) return { error: `contract.tokenSource${/^(kind|path|selectors|themes)\b/.test(problem) ? "." : " "}${problem}` };
      contract.tokenSource = structuredClone(value) as TokenSourceConfig;
      continue;
    }
    const check = CONTRACT_CHECKS[key];
    if (!check) return { error: `unknown contract key "${key}"` };
    const problem = check(value);
    if (problem) return { error: `contract.${key} ${problem}` };
    (contract as unknown as Record<string, unknown>)[key] = structuredClone(value);
  }
  return { contract };
}
