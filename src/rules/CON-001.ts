import type { Rule, Violation } from "../gates/types.js";
import { sortViolations } from "./cnt-text.js";
import { globToRegExp } from "./tok-slots.js";

/** CON-001: a source reusable component without a pen-map entry, or whose mapped path is missing (opt-in). */
export const con001: Rule = (compiled, config, _diff, contract) => {
  const map = contract?.map;
  if (!map) return [];
  const globs = config.rules["CON-001"].requireFor.map(globToRegExp);
  const out: Violation[] = [];
  for (const node of compiled.nodes) {
    if (node.expanded || node.props.reusable !== true || node.instanceOf !== undefined) continue;
    const name = typeof node.props.name === "string" ? node.props.name : node.sourceId;
    if (globs.length > 0 && !globs.some((re) => re.test(name))) continue;
    const entry = map.entries.get(node.sourceId);
    const base = { rule: "CON-001", severity: "warn" as const, file: compiled.file, nodeId: node.id, path: node.path };
    if (!entry) out.push({ ...base, message: `Component "${name}" has no entry in ${map.file}` });
    else if (!entry.designOnly && entry.path !== undefined && map.missingPaths?.has(entry.path))
      out.push({ ...base, prop: "path", message: `Component "${name}" maps to "${entry.path}", which does not exist` });
  }
  return sortViolations(out);
};
