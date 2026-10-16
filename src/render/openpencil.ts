import { readFile } from "node:fs/promises";
import { type SceneGraph, fontManager, headlessRenderNodes } from "@open-pencil/core";
import { estimateTextSize } from "@open-pencil/core/layout";
import type { PenDocument, PenNode } from "../pen/types.js";
import type { DesignSource } from "../source/types.js";
import { penSource } from "../source/load.js";
import { findNode } from "./themes.js";
import type { NodeBox, RenderOptions, RenderResult, Renderer } from "./renderer.js";

export { prepareDocument, resolveVariable } from "./themes.js";

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

function collectIds(node: PenNode, out: string[]): string[] {
  out.push(node.id);
  for (const child of node.children ?? []) collectIds(child, out);
  return out;
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

/** Page (canvas) that holds `nodeId`, found by walking its ancestors. */
function pageIdOf(graph: SceneGraph, nodeId: string): string | undefined {
  for (let node = graph.getNode(nodeId); node; node = node.parentId ? graph.getNode(node.parentId) : undefined) {
    if (node.type === "CANVAS") return node.id;
  }
  return undefined;
}

/** Renderer backed by OpenPencil's headless CanvasKit (WASM) pipeline; needs no display or GPU. */
export function createOpenPencilRenderer(options: OpenPencilRendererOptions = {}): Renderer {
  const defaultScale = options.scale ?? DEFAULT_SCALE;
  const fontsDir = options.fontsDir ?? DEFAULT_FONTS_DIR;

  async function render(source: DesignSource, frameId: string, opts: Partial<RenderOptions>): Promise<RenderResult> {
    const scale = opts.scale ?? defaultScale;
    const { doc } = source;
    const frameNode = findNode(doc.children, frameId);
    if (!frameNode) throw new Error(`Frame not found: ${frameId}`);
    await registerFonts(fontsDir);

    const graph = await source.sceneFor(frameId, opts.theme);
    const graphFrameId = source.graphIdOf(frameId);
    const frame = graphFrameId ? graph.getNode(graphFrameId) : undefined;
    const pageId = graphFrameId ? pageIdOf(graph, graphFrameId) : undefined;
    if (!graphFrameId || !frame || !pageId) throw new Error(`Frame not found in OpenPencil scene: ${frameId}`);

    if (source.format === "pen") measureAutoSizedText(graph);
    const data = await headlessRenderNodes(graph, pageId, [graphFrameId], { scale, format: "PNG" });
    if (!data) throw new Error(`OpenPencil rendered nothing for frame: ${frameId}`);
    const png = Buffer.from(data);

    const origin = graph.getAbsoluteBounds(graphFrameId);
    const nodeBoxes: Record<string, NodeBox> = {};
    for (const id of collectIds(frameNode, [])) {
      const graphId = source.graphIdOf(id);
      if (!graphId || !graph.getNode(graphId)) continue;
      const b = graph.getAbsoluteBounds(graphId);
      nodeBoxes[id] = {
        x: (b.x - origin.x) * scale,
        y: (b.y - origin.y) * scale,
        w: b.width * scale,
        h: b.height * scale,
      };
    }
    return { png, ...pngSize(png), nodeBoxes };
  }

  return {
    renderFrame: (doc, frameId, opts) => render(penSource(doc), frameId, opts),
    renderSource: (source, frameId, opts) => render(source, frameId, opts),
  };
}
