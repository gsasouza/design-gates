import { type SceneGraph, type SceneNode, decodeMessage, decompressFigKiwiDataAsync, initCodec, parseFigKiwiChunks } from "@open-pencil/core";
import { inflateRawSync } from "node:zlib";

interface Change {
  guid?: { sessionID: number; localID: number };
  parentIndex?: { guid?: { sessionID: number; localID: number }; position?: string };
}

const guidKey = (g: { sessionID: number; localID: number }): string => `${g.sessionID}:${g.localID}`;
const ZIP_END_MAGIC = 0x06054b50;

/** The fig-kiwi blob of a `.fig`: the bytes themselves when bare, else the `canvas.fig` entry of the zip archive. */
function kiwiBlob(bytes: Buffer): Buffer | undefined {
  if (bytes.toString("latin1", 0, 8) === "fig-kiwi") return bytes;
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (bytes.readUInt32LE(i) === ZIP_END_MAGIC) {
      end = i;
      break;
    }
  }
  if (end < 0) return undefined;
  let offset = bytes.readUInt32LE(end + 16);
  for (let n = 0, count = bytes.readUInt16LE(end + 10); n < count && offset + 46 <= bytes.length; n++) {
    const nameLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.toString("utf8", offset + 46, offset + 46 + nameLength);
    const method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20);
    const local = bytes.readUInt32LE(offset + 42);
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
    if (name !== "canvas.fig" || local + 30 > bytes.length) continue;
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const raw = bytes.subarray(start, start + compressed);
    return method === 0 ? raw : method === 8 ? inflateRawSync(raw) : undefined;
  }
  return undefined;
}

/**
 * Figma GUIDs for the nodes the reader gives no `source.id` (components, instances and what sits
 * under them), found by pairing the graph's tree with the file's node changes in sibling order.
 * Keyed by graph node id; a subtree whose shape does not pair up is left out (the caller falls back).
 */
export async function figGuids(
  bytes: Buffer,
  graph: SceneGraph,
  decompress: (chunk: Uint8Array) => Promise<Uint8Array> = decompressFigKiwiDataAsync,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const blob = kiwiBlob(bytes);
  const chunks = blob && parseFigKiwiChunks(blob);
  if (!chunks) return out;
  await initCodec();
  const changes = (decodeMessage(await decompress(chunks[1]!)) as { nodeChanges?: Change[] }).nodeChanges ?? [];

  const byParent = new Map<string, Change[]>();
  for (const change of changes) {
    const parent = change.parentIndex?.guid;
    if (!parent || !change.guid) continue;
    byParent.set(guidKey(parent), [...(byParent.get(guidKey(parent)) ?? []), change]);
  }
  for (const list of byParent.values()) list.sort((a, b) => ((a.parentIndex?.position ?? "") < (b.parentIndex?.position ?? "") ? -1 : 1));

  const walk = (node: SceneNode, guid: string): void => {
    out.set(node.id, guid);
    if (node.type === "INSTANCE") return;
    const kids = graph.getChildren(node.id).filter((c) => !c.internalOnly);
    const pairs = byParent.get(guid) ?? [];
    if (kids.length !== pairs.length) return;
    // A reader-given id that disagrees with the paired change means the shapes do not pair: skip the subtree.
    if (kids.some((kid, i) => kid.source.id && kid.source.id !== guidKey(pairs[i]!.guid!))) return;
    kids.forEach((kid, i) => walk(kid, kid.source.id ?? guidKey(pairs[i]!.guid!)));
  };
  for (const page of graph.getPages()) if (page.source.id) walk(page, page.source.id);
  return out;
}
