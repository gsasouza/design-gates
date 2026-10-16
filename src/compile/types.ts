import type { PenThemes, PenVariables } from "../pen/types.js";
import type { ResolveResult, Theme } from "../render/themes.js";

/** Where a property value comes from: copied from a reusable component, or set on the node itself (own prop or instance override). */
export type Provenance = { origin: "component"; sourceNodeId: string } | { origin: "instance" };

/** A `$variable` reference found in a property, resolved for the node's effective theme. */
export interface VariableUse {
  /** Dotted path of the property, e.g. `stroke.fill` or `fill[0].color`. */
  prop: string;
  /** Variable name without `$`. */
  name: string;
  status: ResolveResult["status"];
  /** Resolved value, or the unresolved `$name` when `status` is not `ok`. */
  value: unknown;
  chain: string[];
}

export interface CompiledNode {
  /**
   * Unique, never contains `/`. A source node keeps its own id (a duplicate gets `~2`, `~3`...);
   * a node expanded from a component is `<parent compiled id>::<source id>`, so it is
   * `<instance id>::<id>[::<id>...]` below an instance. The instance itself keeps its id.
   */
  id: string;
  /** The id as written in the document. */
  sourceId: string;
  type: string;
  /** Own props after instance expansion, without `id`, `type`, `children` and `descendants`. */
  props: Record<string, unknown>;
  parentId?: string;
  /** Ancestor compiled ids, top-level frame first. */
  parents: string[];
  /** Source ids joined by `/` from the top-level frame. */
  path: string;
  topFrameId: string;
  children: string[];
  /** Effective theme: axis defaults overridden by inherited `theme` pins, instance pins included. */
  theme: Theme;
  themeKey: string;
  /** Provenance per prop name; every prop of a node outside any expansion is `instance`. */
  provenance: Record<string, Provenance>;
  uses: VariableUse[];
  /** True for nodes copied from a component below an instance (the instance root is not). */
  expanded: boolean;
  /** Compiled id of the component node this node was copied from. */
  source?: string;
  /** Compiled id of the component an instance node expands. */
  instanceOf?: string;
}

export type DiagnosticRule = "SCH-001" | "SCH-002" | "SCH-003";

export interface CompileDiagnostic {
  rule: DiagnosticRule;
  code:
    | "duplicate-id"
    | "id-contains-slash"
    | "unknown-type"
    | "unknown-version"
    | "unknown-fig-version"
    | "too-deep"
    | "ref-missing"
    | "ref-not-reusable"
    | "ref-cycle"
    | "ref-depth"
    | "descendant-missing"
    | "node-budget"
    | "undefined-variable"
    | "variable-cycle"
    | "escaped-variable";
  nodeId: string;
  path: string;
  prop?: string;
  message: string;
}

export interface CompiledDocument {
  /** Repo-relative POSIX path. */
  file: string;
  /** Present (as `fig`) only for a document normalized from a `.fig`; absent means `.pen`. */
  format?: "fig";
  version: string;
  themes: PenThemes;
  variables: PenVariables;
  /** Pre-order, document order. */
  nodes: CompiledNode[];
  /** Compiled ids of the top-level nodes. */
  topLevel: string[];
  diagnostics: CompileDiagnostic[];
}

export interface CompileOptions {
  file?: string;
  /** Format of the source the document came from; a `.fig` is checked against the fig-kiwi version, not the `.pen` one. */
  format?: "pen" | "fig";
  /** Fig-kiwi version reported for a `.fig` source. */
  figVersion?: number;
}
