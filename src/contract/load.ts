import { DEFAULT_CONTRACT } from "../gates/contract-config.js";
import type { GatesConfig } from "../gates/config.js";
import { readCssCustomProperties } from "./css.js";
import type { ContractData, ContractTokens, TokenValues } from "./data.js";
import { readDtcg } from "./dtcg.js";
import { ContractLoadError } from "./errors.js";
import type { ContractNeeds } from "./needs.js";
import { parsePenMap, type PenMap } from "./pen-map.js";
import type { ContractReader } from "./reader.js";

const isMissing = (err: unknown): boolean => ["ENOENT", "ENOTDIR"].includes((err as { code?: string } | null)?.code ?? "");

/** Text of a contract file; undefined when it is missing and `need` is optional. */
async function readNeeded(reader: ContractReader, file: string, need: "required" | "optional"): Promise<string | undefined> {
  try {
    return await reader.readFile(file);
  } catch (err) {
    if (isMissing(err)) {
      if (need === "optional") return undefined;
      throw new ContractLoadError(file, "file not found");
    }
    throw new ContractLoadError(file, `cannot read: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Distinct entry paths the reader says do not exist. */
async function findMissingPaths(map: PenMap, reader: ContractReader): Promise<Set<string>> {
  const paths = [...new Set([...map.entries.values()].flatMap((e) => (e.path === undefined ? [] : [e.path])))];
  const found = await Promise.all(paths.map((p) => reader.exists(p)));
  return new Set(paths.filter((_, i) => !found[i]));
}

async function loadTokens(config: GatesConfig, reader: ContractReader, need: "required" | "optional"): Promise<ContractTokens | undefined> {
  const source = config.contract?.tokenSource;
  if (!source) {
    if (need === "optional") return undefined;
    throw new ContractLoadError("design-gates.config.json", "an enabled rule needs contract.tokenSource");
  }
  const text = await readNeeded(reader, source.path, need);
  if (text === undefined) return undefined;
  const byTheme = new Map<string, TokenValues>();
  if (source.kind === "css") {
    const themes = Object.entries(source.themes ?? {});
    const defaults = source.selectors ?? [":root"];
    const read = readCssCustomProperties(text, [...defaults, ...themes.map(([, selector]) => selector)], source.path);
    const base: TokenValues = new Map();
    for (const selector of defaults) for (const [k, v] of read.get(selector)!) base.set(k, v);
    byTheme.set("", base);
    for (const [key, selector] of themes) byTheme.set(key, read.get(selector)!);
  } else {
    byTheme.set("", readDtcg(text, source.path));
    for (const [key, file] of Object.entries(source.themes ?? {})) {
      const themed = await readNeeded(reader, file, need);
      if (themed !== undefined) byTheme.set(key, readDtcg(themed, file));
    }
  }
  return { kind: source.kind, byTheme };
}

/**
 * Load what the enabled rules need; undefined (and no reader call at all) when nothing is needed.
 * Throws ContractLoadError for a malformed file or a missing file a rule requires.
 */
export async function loadContract(config: GatesConfig, needs: ContractNeeds, reader: ContractReader): Promise<ContractData | undefined> {
  if (!needs.map && !needs.tokens && !needs.markers) return undefined;
  const mapFile = config.contract?.mapFile ?? DEFAULT_CONTRACT.mapFile;
  const data: ContractData = { mapFile };
  if (needs.map) {
    const text = await readNeeded(reader, mapFile, needs.map);
    if (text !== undefined) {
      data.map = parsePenMap(text, mapFile);
      data.map.missingPaths = await findMissingPaths(data.map, reader);
    }
  }
  if (needs.tokens) {
    const tokens = await loadTokens(config, reader, needs.tokens);
    if (tokens) data.tokens = tokens;
  }
  return data;
}
