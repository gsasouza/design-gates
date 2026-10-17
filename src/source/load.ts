import { type SceneGraph, parsePenFile } from "@open-pencil/core";
import { parseFigFile } from "@open-pencil/core/io/formats/fig";
import { MAX_COMPILED_NODES } from "../compile/constants.js";
import { type NodeChange, figGuids } from "../fig/guids.js";
import { figSceneToPen } from "../fig/normalize.js";
import { figAxes } from "../fig/variables.js";
import { parsePen } from "../pen/load.js";
import { prepareDocument } from "../render/themes.js";
import { type InflateSeams, checkKiwiInflation } from "./inflate-cap.js";
import { designFormatOf } from "./format.js";
import { emittedIdMap } from "./ids.js";
import type { DesignSource } from "./types.js";

/** Largest `.fig` input accepted. */
export const MAX_FIG_BYTES = 256 * 1024 * 1024;
/** Most bytes the entries of a zipped `.fig` may inflate to, in total. */
export const MAX_FIG_INFLATED_BYTES = 512 * 1024 * 1024;

/** Most bytes the fig-kiwi chunks of a `.fig` may inflate to, per chunk and per archive entry. */
export const MAX_FIG_CHUNK_BYTES = 512 * 1024 * 1024;

export interface LoadLimits {
  maxFigChunkBytes?: number;
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

/** The theme state a render may change on a graph, so the next render starts from the file's own. */
interface ThemeState {
  activeMode: Map<string, string>;
  frameModes: Map<string, Record<string, string>>;
}

function snapshotThemeState(graph: SceneGraph): ThemeState {
  return {
    activeMode: new Map(graph.activeMode),
    frameModes: new Map([...graph.getAllNodes()].filter((n) => Object.keys(n.variableModes).length > 0).map((n) => [n.id, { ...n.variableModes }])),
  };
}

function restoreThemeState(graph: SceneGraph, state: ThemeState): void {
  graph.activeMode.clear();
  for (const [collection, mode] of state.activeMode) graph.activeMode.set(collection, mode);
  for (const [id, modes] of state.frameModes) graph.updateNode(id, { variableModes: { ...modes } });
}

function applyFigTheme(graph: SceneGraph, frameId: string, theme: Record<string, string> | undefined): void {
  if (!theme) return;
  const frame = graph.getNode(frameId);
  // The theme is keyed by the normalizer's (deduplicated) axis and mode names.
  for (const [collectionId, { axis, modes }] of figAxes(graph).axes) {
    const wanted = theme[axis];
    const modeId = wanted === undefined ? undefined : [...modes].find(([, name]) => name === wanted)?.[0];
    if (modeId === undefined) continue;
    graph.activeMode.set(collectionId, modeId);
    // Like `.pen`, the requested mode is set on the rendered frame only; nested nodes keep their own pins.
    if (frame && frame.variableModes[collectionId] !== undefined) {
      graph.updateNode(frame.id, { variableModes: { ...frame.variableModes, [collectionId]: modeId } });
    }
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

/** Internal seams of `loadFig`, for tests; not part of `LoadLimits`. */
export interface FigSeams extends InflateSeams {
  parse?: (buffer: ArrayBuffer) => Promise<SceneGraph>;
}

/** A failure of the capped pass or the reader as an `Invalid .fig document` error, once. */
function asFigError(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith("Invalid .fig document: ")) throw err;
  return failFig(message);
}

export async function loadFig(file: string, bytes: Buffer, limits: LoadLimits, seams: FigSeams = {}): Promise<DesignSource> {
  const maxBytes = limits.maxFigBytes ?? MAX_FIG_BYTES;
  if (bytes.length > maxBytes) failFig(`${file} is ${bytes.length} bytes, over the ${maxBytes} byte cap (MAX_FIG_BYTES)`);
  checkInflatedSize(bytes, limits.maxFigInflatedBytes ?? MAX_FIG_INFLATED_BYTES);
  const chunkCap = limits.maxFigChunkBytes ?? MAX_FIG_CHUNK_BYTES;
  const overCap = (): never => failFig(`decompressed data passes the ${chunkCap} byte cap (MAX_FIG_CHUNK_BYTES)`);
  let changes: NodeChange[] | undefined;
  try {
    // The one capped decompression and decode; it passes before the reader sees the file.
    changes = await checkKiwiInflation(bytes, chunkCap, overCap, seams);
  } catch (err) {
    return asFigError(err);
  }

  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  let graph: SceneGraph;
  try {
    // parseFigFile takes only the raw bytes and decompresses them again internally, with no hook to
    // cap or reuse that; the chunks were proven under the budget just above.
    graph = await (seams.parse ?? parseFigFile)(copy);
  } catch (err) {
    return asFigError(err);
  }
  const guids = figGuids(graph, changes ?? []);
  const maxNodes = limits.maxNodes ?? MAX_COMPILED_NODES;
  const nodes = [...graph.getAllNodes()];
  if (nodes.length > maxNodes) failFig(`${file} has more than ${maxNodes} nodes (MAX_COMPILED_NODES)`);
  const emitted: Array<[string, string]> = [];
  const doc = figSceneToPen(graph, guids, emitted);
  let ids: Map<string, string>;
  try {
    ids = emittedIdMap(emitted);
  } catch (err) {
    return failFig(`${file} has ${err instanceof Error ? err.message : String(err)}`);
  }

  // One parse serves every render: each starts from the theme state the file came with.
  const pristine = snapshotThemeState(graph);
  return {
    format: "fig",
    doc,
    ...(graph.figKiwiVersion !== null && { figVersion: graph.figKiwiVersion }),
    async sceneFor(frameId, theme) {
      restoreThemeState(graph, pristine);
      applyFigTheme(graph, ids.get(frameId) ?? frameId, theme);
      return graph;
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
