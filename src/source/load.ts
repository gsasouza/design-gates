import { type SceneGraph, parsePenFile } from "@open-pencil/core";
import { parseFigFile } from "@open-pencil/core/io/formats/fig";
import { MAX_COMPILED_NODES } from "../compile/constants.js";
import { figNodeId, figSceneToPen } from "../fig/normalize.js";
import { parsePen } from "../pen/load.js";
import { prepareDocument } from "../render/themes.js";
import { designFormatOf } from "./format.js";
import type { DesignSource } from "./types.js";

/** Largest `.fig` input accepted. */
export const MAX_FIG_BYTES = 256 * 1024 * 1024;
/** Most bytes the entries of a zipped `.fig` may inflate to, in total. */
export const MAX_FIG_INFLATED_BYTES = 512 * 1024 * 1024;

export interface LoadLimits {
  maxFigBytes?: number;
  maxFigInflatedBytes?: number;
  maxNodes?: number;
}

const LFS_PREFIX = "version https://git-lfs.github.com/spec/v1";

const ZIP_LOCAL_MAGIC = 0x04034b50;
const ZIP_CENTRAL_MAGIC = 0x02014b50;
const ZIP_END_MAGIC = 0x06054b50;
const ZIP64_SIZE = 0xffffffff;

function failFig(message: string): never {
  throw new Error(`Invalid .fig document: ${message}`);
}

/**
 * Sums the uncompressed sizes the central directory declares and fails once they pass `cap`, before
 * any entry is inflated. A directory that is malformed is left for the reader to reject.
 */
function checkInflatedSize(bytes: Buffer, cap: number): void {
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== ZIP_LOCAL_MAGIC) return;
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (bytes.readUInt32LE(i) === ZIP_END_MAGIC) {
      end = i;
      break;
    }
  }
  if (end < 0) return;
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  let total = 0;
  for (let n = 0; n < count && offset + 46 <= bytes.length; n++) {
    if (bytes.readUInt32LE(offset) !== ZIP_CENTRAL_MAGIC) return;
    const size = bytes.readUInt32LE(offset + 24);
    total += size === ZIP64_SIZE ? Number.POSITIVE_INFINITY : size;
    if (total > cap) failFig(`archive entries inflate past the ${cap} byte cap (MAX_FIG_INFLATED_BYTES)`);
    offset += 46 + bytes.readUInt16LE(offset + 28) + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
}

function applyFigTheme(graph: SceneGraph, theme: Record<string, string> | undefined): void {
  if (!theme) return;
  for (const collection of graph.variableCollections.values()) {
    const wanted = theme[collection.name];
    const mode = wanted === undefined ? undefined : collection.modes.find((m) => m.name === wanted);
    if (mode) graph.activeMode.set(collection.id, mode.modeId);
  }
}

/** The source of an already parsed `.pen` document; its scene is exactly the `.pen` import of the themed document. */
export function penSource(doc: DesignSource["doc"]): DesignSource {
  return {
    format: "pen",
    doc,
    async sceneFor(frameId, theme) {
      return parsePenFile(JSON.stringify(prepareDocument(doc, frameId, theme)));
    },
    graphIdOf: (nodeId) => nodeId,
  };
}

async function loadFig(file: string, bytes: Buffer, limits: LoadLimits): Promise<DesignSource> {
  const maxBytes = limits.maxFigBytes ?? MAX_FIG_BYTES;
  if (bytes.length > maxBytes) failFig(`${file} is ${bytes.length} bytes, over the ${maxBytes} byte cap (MAX_FIG_BYTES)`);
  checkInflatedSize(bytes, limits.maxFigInflatedBytes ?? MAX_FIG_INFLATED_BYTES);

  const parse = async (): Promise<SceneGraph> => {
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    try {
      return await parseFigFile(copy);
    } catch (err) {
      return failFig(err instanceof Error ? err.message : String(err));
    }
  };

  const graph = await parse();
  const maxNodes = limits.maxNodes ?? MAX_COMPILED_NODES;
  const nodes = [...graph.getAllNodes()];
  if (nodes.length > maxNodes) failFig(`${file} has more than ${maxNodes} nodes (MAX_COMPILED_NODES)`);
  const ids = new Map(nodes.map((node) => [figNodeId(node), node.id]));

  // The first render takes the graph parsed for the normalizer; later ones parse afresh because rendering mutates the graph.
  let spare: SceneGraph | undefined = graph;
  return {
    format: "fig",
    doc: figSceneToPen(graph),
    ...(graph.figKiwiVersion !== null && { figVersion: graph.figKiwiVersion }),
    async sceneFor(_frameId, theme) {
      const scene = spare ?? (await parse());
      spare = undefined;
      applyFigTheme(scene, theme);
      return scene;
    },
    graphIdOf: (nodeId) => ids.get(nodeId),
  };
}

/**
 * Loads a design file by its extension. `.pen` is decoded as UTF-8 text; `.fig` is read as bytes,
 * either the zip archive Figma saves or a bare fig-kiwi blob. Failures throw like a `.pen` parse error.
 */
export async function loadDesignSource(file: string, content: Buffer | string, limits: LoadLimits = {}): Promise<DesignSource> {
  const format = designFormatOf(file);
  if (!format) throw new Error(`Unsupported design file (expected .pen or .fig): ${file}`);
  const head = typeof content === "string" ? content.slice(0, LFS_PREFIX.length) : content.subarray(0, LFS_PREFIX.length).toString("latin1");
  if (head === LFS_PREFIX) {
    throw new Error(`Invalid .${format} document: ${file} is a Git LFS pointer; run git lfs pull to fetch the real .${format}`);
  }
  if (format === "pen") return penSource(parsePen(typeof content === "string" ? content : content.toString("utf8")));
  if (typeof content === "string") throw new Error(`A .fig file must be read as bytes: ${file}`);
  return loadFig(file, content, limits);
}
