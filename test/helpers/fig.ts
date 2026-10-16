import { crc32, inflateRawSync, constants } from "node:zlib";
import {
  buildFigKiwi,
  decodeMessage,
  encodeMessage,
  parseFigKiwiChunks,
  parsePenFile,
} from "@open-pencil/core";
import { exportFigFile } from "@open-pencil/core/io/formats/fig";

export interface ZipEntry {
  name: string;
  data: Uint8Array;
  /** Uncompressed size written to the central directory instead of the real one. */
  declaredSize?: number;
}

/** A zip archive of stored (uncompressed) entries, like the one Figma saves. */
export function storedZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const data = Buffer.from(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(e.declaredSize ?? data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export interface FigRect {
  id: string;
  name: string;
  fill: string;
}

/** A frame "Card" holding the rectangles, as a bare fig-kiwi blob (the older form of a .fig file). */
export async function bareFig(rects: FigRect[]): Promise<Buffer> {
  const doc = {
    version: "2.6",
    children: [
      {
        id: "frame",
        type: "frame",
        name: "Card",
        width: 40,
        height: 20,
        layout: "none",
        children: rects.map((r, i) => ({ id: r.id, type: "rectangle", name: r.name, x: i * 20, y: 0, width: 20, height: 20, fill: r.fill })),
      },
    ],
  };
  const zip = Buffer.from(await exportFigFile(parsePenFile(JSON.stringify(doc))));
  // canvas.fig is the first entry and stored, so its bytes follow the 30 byte local header and the name.
  return Buffer.from(zip.subarray(30 + "canvas.fig".length, 30 + "canvas.fig".length + zip.readUInt32LE(18)));
}

/** The same nodes with the same GUIDs, with the first two siblings named in `names` swapped in file order and position. */
export function swapSiblings(canvas: Buffer, names: [string, string]): Buffer {
  const chunks = parseFigKiwiChunks(canvas)!;
  const message = decodeMessage(inflateRawSync(chunks[1], { finishFlush: constants.Z_SYNC_FLUSH }));
  const changes = message.nodeChanges!;
  const [first, second] = names.map((n) => changes.find((c) => c.name === n)!);
  const position = first!.parentIndex!.position;
  first!.parentIndex!.position = second!.parentIndex!.position;
  second!.parentIndex!.position = position;
  message.nodeChanges = [...changes].reverse();
  return Buffer.from(buildFigKiwi(chunks[0], encodeMessage(message)));
}

/** A bare fig-kiwi blob wrapped in the zip archive Figma's "Save local copy" writes. */
export function zipFig(canvas: Buffer): Buffer {
  return storedZip([
    { name: "canvas.fig", data: canvas },
    { name: "meta.json", data: Buffer.from("{}") },
  ]);
}
