import type { GatesConfig } from "../gates/config.js";
import type { Rule, Violation } from "../gates/types.js";
import { isVariant, listCandidates, variantsOf, type Candidate, type VariantNaming } from "./variants.js";

const globToRegExp = (glob: string): RegExp => new RegExp(`^${glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface Breakpoint {
  name: string;
  width?: number;
}

const breakpointsOf = (config: GatesConfig): Breakpoint[] =>
  config.rules["RSP-001"].breakpoints.map((e) => (typeof e === "string" ? { name: e } : { name: e.name, width: e.width }));

/** Breakpoint naming inputs of the resolved RSP-001 config, whether or not the rule is enabled. */
export function breakpointNaming(config: GatesConfig): Pick<VariantNaming, "breakpointPattern" | "breakpoints"> {
  return { breakpointPattern: config.rules["RSP-001"].pattern, breakpoints: breakpointsOf(config).map((b) => b.name) };
}

export const rsp001: Rule = (compiled, config) => {
  const { screens, baseBreakpoint } = config.rules["RSP-001"];
  const breakpoints = breakpointsOf(config);
  const globs = screens.map(globToRegExp);
  const naming: VariantNaming = { statePattern: config.rules["STA-001"].pattern, states: config.rules["STA-001"].states, ...breakpointNaming(config) };
  const isBase = (b: Breakpoint): boolean => baseBreakpoint !== undefined && b.name.trim().toLowerCase() === baseBreakpoint.trim().toLowerCase();
  const out: Violation[] = [];

  const checkWidth = (frame: Candidate, b: Breakpoint): void => {
    if (b.width === undefined) return;
    const actual = frame.node.props.width;
    if (actual === b.width) return;
    out.push({
      rule: "RSP-001",
      severity: "warn",
      file: compiled.file,
      nodeId: frame.node.id,
      path: frame.node.path,
      prop: "width",
      message: `Breakpoint frame "${frame.name}" is ${String(actual)} wide; "${b.name}" expects ${b.width}`,
    });
  };

  for (const candidate of listCandidates(compiled)) {
    const { node, name } = candidate;
    if (candidate.kind !== "screen" || isVariant(compiled, candidate, naming)) continue;
    if (globs.length > 0 && !globs.some((g) => [name, node.sourceId, node.id].some((s) => g.test(s)))) continue;
    for (const b of breakpoints) {
      if (isBase(b)) {
        checkWidth(candidate, b);
        continue;
      }
      const frames = variantsOf(compiled, candidate, "breakpoint", b.name, naming);
      if (frames.length === 0) {
        out.push({
          rule: "RSP-001",
          severity: "warn",
          file: compiled.file,
          nodeId: node.id,
          path: node.path,
          prop: `breakpoints.${b.name}`,
          message: `Screen "${name}" has no "${b.name}" breakpoint frame`,
        });
      }
      for (const frame of frames) checkWidth(frame, b);
    }
  }
  return out.sort((a, b) => cmp(a.nodeId, b.nodeId) || cmp(a.prop ?? "", b.prop ?? ""));
};
