import type { RuleId } from "../gates/config.js";

export type ContractInput = "map" | "tokens" | "markers";
/** `required`: a missing file is a load error; `optional`: it is left out. */
export type ContractNeed = "required" | "optional";
export type ContractNeeds = Partial<Record<ContractInput, ContractNeed>>;

/**
 * Contract inputs per rule. Later cards add entries
 * (CON-002 -> tokens, DIF-003 -> map + markers) and never change the shape.
 */
export const CONTRACT_NEEDS: Partial<Record<RuleId, ContractNeeds>> = {
  "CON-001": { map: "required" },
  "CON-002": { tokens: "required" },
  "DIF-003": { map: "optional", markers: "optional" },
};

/** Union of the needs of the given rules; `required` wins over `optional`. */
export function mergeNeeds(ids: readonly RuleId[], table: Partial<Record<RuleId, ContractNeeds>> = CONTRACT_NEEDS): ContractNeeds {
  const out: ContractNeeds = {};
  for (const id of ids) {
    for (const [input, need] of Object.entries(table[id] ?? {}) as [ContractInput, ContractNeed][]) {
      if (out[input] !== "required") out[input] = need;
    }
  }
  return out;
}
