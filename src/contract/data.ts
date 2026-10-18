import type { PenMap } from "./pen-map.js";

/** Token values of one theme: token name (`--x`, or a dotted DTCG path) -> value text. */
export type TokenValues = Map<string, string>;

export interface ContractTokens {
  kind: "css" | "dtcg";
  /** Theme key (`axis=value,...`, as CompiledNode.themeKey) -> values; `""` is the default theme. */
  byTheme: Map<string, TokenValues>;
}

export interface MarkerRef {
  file: string;
  /** 1-based. */
  line: number;
}

/** What rules read beyond the .pen documents; each part is present only when a rule asked for it and it loaded. */
export interface ContractData {
  map?: PenMap;
  /** Repo-relative path of the map file, also when `map` was not loaded. */
  mapFile: string;
  tokens?: ContractTokens;
  /** Node id -> where code markers for it were found (files in listing order, lines ascending). */
  markers?: Map<string, MarkerRef[]>;
}
