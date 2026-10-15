import type { PenDocument, PenNode } from "../pen/types.js";
import { defaultTheme, isVariableRef, resolveAlias, type Theme } from "../render/themes.js";
import { themeKey } from "../diff/variables.js";
import { KNOWN_TYPES, KNOWN_VERSIONS, MAX_COMPILED_NODES, MAX_DEPTH, MAX_PROP_DEPTH, MAX_REF_DEPTH } from "./constants.js";
import type { CompileDiagnostic, CompileOptions, CompiledDocument, CompiledNode, Provenance, VariableUse } from "./types.js";

const ESCAPED_VARIABLE = /^\\\$[^\s$]+$/;
/** Props never copied from an instance onto its expanded root (or from an override onto a node). */
const IDENTITY = new Set(["id", "type", "ref", "descendants", "reusable", "children"]);
/** Props that are not part of `props`. */
const STRUCTURAL = new Set(["id", "type", "children", "descendants"]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const sanitize = (id: string): string => id.replaceAll("/", "%2F");
const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function clone<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

interface Draft {
  id: string;
  sourceId: string;
  type: string;
  props: Map<string, unknown>;
  prov: Map<string, Provenance>;
  parent?: Draft;
  children: Draft[];
  path: string;
  expanded: boolean;
  source?: string;
  instanceOf?: string;
}

interface Ctx {
  parent?: Draft;
  /** Inside a component being expanded below an instance. */
  expanding: boolean;
  /** Reusable components being compiled or expanded, outermost first. */
  stack: PenNode[];
  depth: number;
  refDepth: number;
}

/** Compile a document: index nodes, expand instances, compute effective themes and resolve variables. Never throws. */
export function compile(doc: PenDocument, opts: CompileOptions = {}): CompiledDocument {
  const diagnostics = new Map<string, CompileDiagnostic>();
  const diag = (d: CompileDiagnostic): void => {
    diagnostics.set(JSON.stringify([d.rule, d.code, d.nodeId, d.prop ?? "", d.message]), d);
  };
  const variables = isObject(doc.variables) ? (doc.variables as CompiledDocument["variables"]) : {};
  const themes = isObject(doc.themes) ? (doc.themes as CompiledDocument["themes"]) : {};
  const topNodes = (Array.isArray(doc.children) ? doc.children : []).filter(isObject) as PenNode[];
  const version = typeof doc.version === "string" ? doc.version : "";
  if (!KNOWN_VERSIONS.includes(version)) {
    diag({ rule: "SCH-001", code: "unknown-version", nodeId: "", path: "", message: `Unknown document version "${version}"` });
  }

  // Pass 1: assign compiled ids and paths to the source tree, record schema diagnostics.
  const ids = new Map<PenNode, string>();
  const paths = new Map<PenNode, string>();
  const sourceById = new Map<string, PenNode>();
  const used = new Set<string>();
  const unique = (base: string): string => {
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}~${n}`;
    used.add(id);
    return id;
  };
  let seen = 0;
  const index = (node: PenNode, parentPath: string, depth: number): void => {
    if (seen++ >= MAX_COMPILED_NODES) return;
    const raw = typeof node.id === "string" ? node.id : "";
    const id = unique(sanitize(raw));
    const path = parentPath ? `${parentPath}/${id}` : id;
    ids.set(node, id);
    paths.set(node, path);
    if (!sourceById.has(raw)) sourceById.set(raw, node);
    else diag({ rule: "SCH-001", code: "duplicate-id", nodeId: id, path, message: `Duplicate node id "${raw}"` });
    if (raw.includes("/")) diag({ rule: "SCH-001", code: "id-contains-slash", nodeId: id, path, message: `Node id "${raw}" contains "/"` });
    if (!KNOWN_TYPES.includes(node.type)) diag({ rule: "SCH-001", code: "unknown-type", nodeId: id, path, message: `Unknown node type "${String(node.type)}"` });
    if (!Array.isArray(node.children)) return;
    if (depth + 1 >= MAX_DEPTH) {
      diag({ rule: "SCH-001", code: "too-deep", nodeId: id, path, message: `Nesting deeper than ${MAX_DEPTH} levels` });
      return;
    }
    for (const child of node.children) if (isObject(child)) index(child, path, depth + 1);
  };
  for (const node of topNodes) index(node, "", 0);

  // Pass 2: build the compiled tree, expanding instances.
  const roots: Draft[] = [];
  let count = 0;
  const usedCompiled = new Set<string>();
  const compiledId = (preferred: string): string => {
    let id = preferred;
    for (let n = 2; usedCompiled.has(id); n++) id = `${preferred}~${n}`;
    usedCompiled.add(id);
    return id;
  };
  const srcDiag = (src: PenNode, d: Omit<CompileDiagnostic, "nodeId" | "path">): void =>
    diag({ ...d, nodeId: ids.get(src) ?? "", path: paths.get(src) ?? "" });

  const ownProv = (src: PenNode, ctx: Ctx): Provenance => (ctx.expanding ? { origin: "component", sourceNodeId: ids.get(src) ?? "" } : { origin: "instance" });

  const copyProps = (draft: Draft, src: PenNode, ctx: Ctx, skip: Set<string>): void => {
    const prov = ownProv(src, ctx);
    for (const [key, value] of Object.entries(src)) {
      if (skip.has(key)) continue;
      draft.props.set(key, clone(value));
      draft.prov.set(key, prov);
    }
  };

  const make = (src: PenNode, ctx: Ctx, idOverride?: string): Draft | undefined => {
    if (count >= MAX_COMPILED_NODES) {
      diag({ rule: "SCH-002", code: "node-budget", nodeId: "", path: "", message: `Expansion stopped at ${MAX_COMPILED_NODES} compiled nodes` });
      return undefined;
    }
    count++;
    const sourceId = ctx.expanding ? sanitize(typeof src.id === "string" ? src.id : "") : (ids.get(src) ?? "");
    const id = idOverride ?? compiledId(ctx.expanding && ctx.parent ? `${ctx.parent.id}::${sourceId}` : sourceId);
    const draft: Draft = {
      id,
      sourceId: typeof src.id === "string" ? src.id : "",
      type: String(src.type),
      props: new Map(),
      prov: new Map(),
      children: [],
      path: ctx.parent ? `${ctx.parent.path}/${sourceId}` : sourceId,
      expanded: ctx.expanding && ctx.parent !== undefined,
    };
    if (ctx.expanding) draft.source = ids.get(src);
    draft.parent = ctx.parent;
    (ctx.parent?.children ?? roots).push(draft);
    return draft;
  };

  const children = (draft: Draft, src: PenNode, ctx: Ctx): void => {
    if (!Array.isArray(src.children)) return;
    if (ctx.depth + 1 >= MAX_DEPTH) {
      srcDiag(src, { rule: "SCH-001", code: "too-deep", message: `Nesting deeper than ${MAX_DEPTH} levels` });
      return;
    }
    for (const child of src.children) if (isObject(child)) build(child as PenNode, { ...ctx, parent: draft, depth: ctx.depth + 1 });
  };

  const build = (src: PenNode, ctx: Ctx): void => {
    if (src.type === "ref" && typeof src.ref === "string") {
      const target = sourceById.get(src.ref);
      const fail = (code: CompileDiagnostic["code"], message: string): void => {
        srcDiag(src, { rule: "SCH-002", code, message });
        leaf(src, ctx);
      };
      if (!target) return fail("ref-missing", `Instance refers to missing node "${src.ref}"`);
      if (target.reusable !== true) return fail("ref-not-reusable", `Instance refers to "${src.ref}", which is not reusable`);
      if (ctx.stack.includes(target)) {
        const chain = [...ctx.stack.slice(ctx.stack.indexOf(target)), target].map((n) => ids.get(n) ?? "");
        return fail("ref-cycle", `Instance reference cycle: ${chain.join(" -> ")}`);
      }
      if (ctx.refDepth >= MAX_REF_DEPTH) return fail("ref-depth", `Instances nested deeper than ${MAX_REF_DEPTH} levels`);
      expand(src, target, ctx);
      return;
    }
    leaf(src, ctx);
  };

  /** A node compiled as written (including a ref that could not be expanded). */
  const leaf = (src: PenNode, ctx: Ctx): void => {
    const draft = make(src, ctx);
    if (!draft) return;
    copyProps(draft, src, ctx, STRUCTURAL);
    if (ctx.expanding) draft.props.delete("reusable");
    const reusable = src.reusable === true && !ctx.expanding;
    children(draft, src, reusable ? { ...ctx, stack: [...ctx.stack, src] } : ctx);
  };

  const expand = (inst: PenNode, component: PenNode, ctx: Ctx): void => {
    const root = make(inst, ctx);
    if (!root) return;
    root.type = String(component.type);
    root.source = ids.get(component);
    root.instanceOf = ids.get(component);
    const inner: Ctx = { ...ctx, parent: root, expanding: true, stack: [...ctx.stack, component], refDepth: ctx.refDepth + 1 };
    // Component root props, then the instance's own props on top.
    copyProps(root, component, { ...inner, expanding: true }, STRUCTURAL);
    root.props.delete("reusable");
    root.prov.delete("reusable");
    copyProps(root, inst, ctx, IDENTITY);
    children(root, component, { ...inner, parent: root, depth: ctx.depth });
    const overrides = isObject(inst.descendants) ? inst.descendants : {};
    for (const key of Object.keys(overrides).sort(byString)) {
      let target: Draft | undefined = root;
      for (const seg of key.split("/")) target = target?.children.find((c) => c.sourceId === seg);
      const value = overrides[key];
      if (!target || !isObject(value)) {
        srcDiag(inst, { rule: "SCH-002", code: "descendant-missing", prop: key, message: `Override path "${key}" not found in "${String(inst.ref)}"` });
        continue;
      }
      const prov = ownProv(inst, ctx);
      for (const [prop, v] of Object.entries(value)) {
        if (IDENTITY.has(prop)) continue;
        target.props.set(prop, clone(v));
        target.prov.set(prop, prov);
      }
    }
  };

  for (const node of topNodes) build(node, { expanding: false, stack: [], depth: 0, refDepth: 0 });

  // Pass 3: effective themes, variable resolution and the flat node list.
  const nodes: CompiledNode[] = [];
  const addUse = (node: CompiledNode, draft: Draft, prop: string, result: VariableUse): void => {
    node.uses.push(result);
    const own = draft.prov.get(prop.split(/[.[]/)[0] ?? "")?.origin !== "component";
    // A use inherited from a component is reported once, on the component itself.
    if (!own) return;
    const at = { nodeId: node.id, path: node.path, prop };
    if (result.status === "undefined") diag({ rule: "SCH-003", code: "undefined-variable", ...at, message: `Variable $${result.name} is not defined` });
    if (result.status === "cycle" || result.status === "too-deep") {
      diag({ rule: "SCH-003", code: "variable-cycle", ...at, message: `Variable alias cycle: ${result.chain.map((n) => `$${n}`).join(" -> ")}` });
    }
  };

  const scan = (node: CompiledNode, draft: Draft, value: unknown, key: string, prop: string, depth: number): void => {
    if (depth > MAX_PROP_DEPTH) return;
    if (typeof value === "string") {
      if (isVariableRef(key, value)) {
        const r = resolveAlias(value, variables, node.theme);
        addUse(node, draft, prop, { prop, name: value.slice(1), status: r.status, value: r.value, chain: r.chain });
      } else if (key !== "id" && key !== "type" && key !== "ref" && key !== "name" && ESCAPED_VARIABLE.test(value)) {
        if (draft.prov.get(prop.split(/[.[]/)[0] ?? "")?.origin !== "component") {
          diag({ rule: "SCH-003", code: "escaped-variable", nodeId: node.id, path: node.path, prop, message: `Escaped variable string "${value}"` });
        }
      }
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => scan(node, draft, v, key, `${prop}[${i}]`, depth + 1));
    } else if (isObject(value)) {
      for (const k of Object.keys(value)) if (k !== "theme") scan(node, draft, value[k], k, `${prop}.${k}`, depth + 1);
    }
  };

  const finalize = (draft: Draft, parents: string[], inherited: Theme): void => {
    const pin = draft.props.get("theme");
    const theme: Theme = { ...inherited };
    if (isObject(pin)) for (const [axis, v] of Object.entries(pin)) if (typeof v === "string") theme[axis] = v;
    const sortedTheme = Object.fromEntries(Object.entries(theme).sort(([a], [b]) => byString(a, b)));
    const node: CompiledNode = {
      id: draft.id,
      sourceId: draft.sourceId,
      type: draft.type,
      props: Object.fromEntries([...draft.props].sort(([a], [b]) => byString(a, b))),
      ...(parents.length ? { parentId: parents[parents.length - 1] } : {}),
      parents,
      path: draft.path,
      topFrameId: parents[0] ?? draft.id,
      children: draft.children.map((c) => c.id),
      theme: sortedTheme,
      themeKey: themeKey(sortedTheme),
      provenance: Object.fromEntries([...draft.prov].sort(([a], [b]) => byString(a, b))),
      uses: [],
      expanded: draft.expanded,
      ...(draft.source !== undefined ? { source: draft.source } : {}),
      ...(draft.instanceOf !== undefined ? { instanceOf: draft.instanceOf } : {}),
    };
    nodes.push(node);
    for (const [key, value] of draft.props) scan(node, draft, value, key, key, 0);
    for (const child of draft.children) finalize(child, [...parents, draft.id], theme);
  };
  const base = defaultTheme(themes);
  for (const root of roots) finalize(root, [], base);

  return {
    file: opts.file ?? "",
    version,
    themes,
    variables,
    nodes,
    topLevel: roots.map((r) => r.id),
    diagnostics: [...diagnostics.values()].sort(
      (a, b) =>
        byString(a.rule, b.rule) || byString(a.nodeId, b.nodeId) || byString(a.code, b.code) || byString(a.prop ?? "", b.prop ?? "") || byString(a.message, b.message),
    ),
  };
}
