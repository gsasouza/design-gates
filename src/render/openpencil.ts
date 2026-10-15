import { readFile } from "node:fs/promises";
import { type SceneGraph, fontManager, headlessRenderNodes, parsePenFile } from "@open-pencil/core";
import { estimateTextSize } from "@open-pencil/core/layout";
import type { PenDocument, PenNode, PenThemes, PenVariable, PenVariables } from "../pen/types.js";
import type { NodeBox, RenderOptions, RenderResult, Renderer } from "./renderer.js";

export interface OpenPencilRendererOptions {
  /** Default scale when `renderFrame` is not given one. Defaults to 1. */
  scale?: number;
  /** Directory holding the Inter font files. Defaults to the committed `fixtures/fonts`. */
  fontsDir?: URL;
}

const DEFAULT_SCALE = 1;
const DEFAULT_FONTS_DIR = new URL("../../../fixtures/fonts/", import.meta.url);
const FONT_FILES: Record<string, string> = {
  Regular: "Inter-Regular.ttf",
  Medium: "Inter-Medium.ttf",
  SemiBold: "Inter-SemiBold.ttf",
  Bold: "Inter-Bold.ttf",
};

const registered = new Set<string>();

/** Register the committed fonts so OpenPencil never resolves Inter from system or online sources. */
async function registerFonts(dir: URL): Promise<void> {
  fontManager.setOnlineFontProviders({
    google: false,
    fontsource: false,
    bunny: false,
    fontshare: false,
  });
  for (const [style, file] of Object.entries(FONT_FILES)) {
    const url = new URL(file, dir);
    if (registered.has(url.href)) continue;
    const buf = await readFile(url);
    const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    fontManager.markLoaded("Inter", style, data, "registered");
    registered.add(url.href);
  }
}

function findNode(nodes: PenNode[], id: string): PenNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = node.children && findNode(node.children, id);
    if (found) return found;
  }
  return undefined;
}

function collectIds(node: PenNode, out: string[]): string[] {
  out.push(node.id);
  for (const child of node.children ?? []) collectIds(child, out);
  return out;
}

const VARIABLE_REF = /^\$[^\s$]+$/;
/** Keys whose string values are data, never variable references. */
const LITERAL_KEYS = new Set(["id", "name", "content", "type", "ref"]);

type Theme = Record<string, string>;

function isTheme(value: unknown): value is Theme {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Value of `variable` under `theme`: the last entry (document order) whose theme is satisfied; no theme is always satisfied. */
export function resolveVariable(variable: PenVariable, theme: Theme): unknown {
  if (!Array.isArray(variable.value)) return variable.value;
  const entries = variable.value as { value: unknown; theme?: Theme }[];
  return entries.filter((e) => Object.entries(e.theme ?? {}).every(([axis, v]) => theme[axis] === v)).at(-1)?.value;
}

/** Resolve `$name` to a concrete value, following alias chains (a variable whose value is `$other`). */
function resolveReference(ref: string, variables: PenVariables, theme: Theme): unknown {
  const seen: string[] = [];
  let current: unknown = ref;
  while (typeof current === "string" && VARIABLE_REF.test(current)) {
    const name = current.slice(1);
    const variable = variables[name];
    const next = variable ? resolveVariable(variable, theme) : undefined;
    if (next === undefined) return current;
    if (seen.includes(name)) throw new Error(`Variable alias cycle: ${[...seen, name].map((n) => `$${n}`).join(" -> ")}`);
    seen.push(name);
    current = next;
  }
  return current;
}

/**
 * Replace `$variable` references under `value` with their concrete value for the theme in effect
 * at that point (a node's own `theme` pin overrides the inherited one). OpenPencil 0.15's .pen
 * import resolves variables at the first theme regardless of `theme` pins, so the theme is applied
 * here instead and the importer only ever sees literals.
 */
function bakeVariables(value: unknown, variables: PenVariables, theme: Theme): unknown {
  if (Array.isArray(value)) return value.map((v) => bakeVariables(v, variables, theme));
  if (typeof value !== "object" || value === null) return value;
  const node = value as Record<string, unknown>;
  const here = isTheme(node.theme) ? { ...theme, ...node.theme } : theme;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(node)) {
    if (typeof v === "string") {
      out[key] = LITERAL_KEYS.has(key) || !VARIABLE_REF.test(v) ? v : resolveReference(v, variables, here);
    } else {
      out[key] = key === "theme" ? v : bakeVariables(v, variables, here);
    }
  }
  return out;
}

/** Axis defaults: the first value of each declared theme axis. */
function defaultTheme(themes: PenThemes | undefined): Theme {
  return Object.fromEntries(Object.entries(themes ?? {}).flatMap(([axis, values]) => (values[0] ? [[axis, values[0]]] : [])));
}

/**
 * Copy of `doc` for OpenPencil with `theme` pinned on the frame and every variable reference
 * resolved for the theme in effect. The caller's document is never mutated.
 */
export function prepareDocument(doc: PenDocument, frameId: string, theme?: Theme): PenDocument {
  const copy = structuredClone(doc);
  const frame = findNode(copy.children, frameId);
  if (frame && theme) frame.theme = { ...frame.theme, ...theme };
  const variables = copy.variables ?? {};
  const children = bakeVariables(copy.children, variables, defaultTheme(copy.themes)) as PenNode[];
  return { ...copy, children };
}

/** Width and height from the PNG IHDR chunk. */
function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/**
 * The .pen import leaves auto-sized text at width 0 outside auto-layout containers; size it with
 * OpenPencil's own text measurement (over the registered fonts) so it has a real box.
 */
function measureAutoSizedText(graph: SceneGraph): void {
  for (const node of graph.getAllNodes()) {
    if (node.type !== "TEXT" || node.textAutoResize === "NONE") continue;
    const parent = node.parentId ? graph.getNode(node.parentId) : undefined;
    if (parent && parent.layoutMode !== "NONE") continue;
    const fixedWidth = node.textAutoResize === "HEIGHT";
    const size = estimateTextSize(node, fixedWidth ? node.width : undefined);
    graph.updateNode(node.id, { width: fixedWidth ? node.width : size.width, height: size.height });
  }
}

/** Renderer backed by OpenPencil's headless CanvasKit (WASM) pipeline; needs no display or GPU. */
export function createOpenPencilRenderer(options: OpenPencilRendererOptions = {}): Renderer {
  const defaultScale = options.scale ?? DEFAULT_SCALE;
  const fontsDir = options.fontsDir ?? DEFAULT_FONTS_DIR;

  return {
    async renderFrame(doc, frameId, opts: Partial<RenderOptions> = {}): Promise<RenderResult> {
      const scale = opts.scale ?? defaultScale;
      const source = findNode(doc.children, frameId);
      if (!source) throw new Error(`Frame not found: ${frameId}`);
      await registerFonts(fontsDir);

      const graph = parsePenFile(JSON.stringify(prepareDocument(doc, frameId, opts.theme)));
      const frame = graph.getNode(frameId);
      const page = graph.getPages(true)[0];
      if (!frame || !page) throw new Error(`Frame not found in OpenPencil scene: ${frameId}`);

      measureAutoSizedText(graph);
      const data = await headlessRenderNodes(graph, page.id, [frameId], { scale, format: "PNG" });
      if (!data) throw new Error(`OpenPencil rendered nothing for frame: ${frameId}`);
      const png = Buffer.from(data);

      const origin = graph.getAbsoluteBounds(frameId);
      const nodeBoxes: Record<string, NodeBox> = {};
      for (const id of collectIds(source, [])) {
        if (!graph.getNode(id)) continue;
        const b = graph.getAbsoluteBounds(id);
        nodeBoxes[id] = {
          x: (b.x - origin.x) * scale,
          y: (b.y - origin.y) * scale,
          w: b.width * scale,
          h: b.height * scale,
        };
      }
      return { png, ...pngSize(png), nodeBoxes };
    },
  };
}
