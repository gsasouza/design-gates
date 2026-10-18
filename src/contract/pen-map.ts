import { isRepoRelativePath } from "../gates/contract-config.js";
import { ContractLoadError } from "./errors.js";

export interface PenMapEntry {
  /** Code path, repo-relative; absent for a design-only component. */
  path?: string;
  designOnly?: true;
  /** 1-based line of the entry's key in the map file, when found. */
  line?: number;
}

export interface PenMap {
  file: string;
  /** Component id -> entry, in file order. */
  entries: Map<string, PenMapEntry>;
  /** Entry paths that do not exist in the repo; filled by the loader (absent until then). */
  missingPaths?: Set<string>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Line of the top-level key `id` (nested keys with the same name are ignored). */
function lineOf(text: string, id: string): number | undefined {
  let depth = 0;
  let line = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\n") line++;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    else if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (depth === 1 && /^\s*:/.test(text.slice(j + 1, j + 64)) && decodeKey(text.slice(i, j + 1)) === id) return line;
      line += text.slice(i, j).split("\n").length - 1;
      i = j;
    }
  }
  return undefined;
}

function decodeKey(literal: string): string | undefined {
  try {
    return JSON.parse(literal) as string;
  } catch {
    return undefined;
  }
}

function parseEntry(file: string, id: string, raw: unknown): PenMapEntry {
  const fail = (reason: string): never => {
    throw new ContractLoadError(file, `component "${id}": ${reason}`);
  };
  const checkPath = (p: unknown): string => {
    if (typeof p !== "string" || !isRepoRelativePath(p)) return fail("path must be a non-empty repo-relative path without ..");
    return p;
  };
  if (typeof raw === "string") return { path: checkPath(raw) };
  if (!isObject(raw)) return fail('expected a code path string or { "path"?: string, "designOnly"?: true }');
  for (const key of Object.keys(raw)) if (key !== "path" && key !== "designOnly") fail(`unknown key "${key}"`);
  if (raw.designOnly !== undefined && raw.designOnly !== true) fail('"designOnly" must be true when present');
  if (raw.path === undefined && raw.designOnly !== true) fail('needs a "path" unless "designOnly" is true');
  return { ...(raw.path !== undefined && { path: checkPath(raw.path) }), ...(raw.designOnly === true && { designOnly: true as const }) };
}

/** Parse pen-map.json text; throws ContractLoadError naming `file` (and the component id for a bad entry). */
export function parsePenMap(text: string, file: string): PenMap {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ContractLoadError(file, `invalid JSON: ${(err as Error).message}`);
  }
  if (!isObject(raw)) throw new ContractLoadError(file, "expected a JSON object mapping component ids to code paths");
  const entries = new Map<string, PenMapEntry>();
  for (const [id, value] of Object.entries(raw)) {
    const entry = parseEntry(file, id, value);
    const line = lineOf(text, id);
    entries.set(id, line === undefined ? entry : { ...entry, line });
  }
  return { file, entries };
}
