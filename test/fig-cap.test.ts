import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deflateRawSync } from "node:zlib";
import { SceneGraph, type SceneNode, decodeMessage, decompressFigKiwiDataAsync, parseFigKiwiChunks } from "@open-pencil/core";
import { parseFigFile } from "@open-pencil/core/io/formats/fig";
import { figGuids } from "../src/fig/guids.js";
import { figSceneToPen } from "../src/fig/normalize.js";
import { emittedIdMap } from "../src/source/ids.js";
import { decompressChunkCapped } from "../src/source/inflate-cap.js";
import { loadDesignSource, loadFig } from "../src/source/load.js";
import { bareFig, storedZip, zipFig } from "./helpers/fig.js";
import { kiwiBlobOf, rawZstdFrame, rleBombFrame } from "./helpers/zstd.js";

const CAP_ERROR = /Invalid \.fig document: decompressed data passes the \d+ byte cap \(MAX_FIG_CHUNK_BYTES\)/;
const RECTS = [
  { id: "a", name: "A", fill: "#ff0000" },
  { id: "b", name: "B", fill: "#00ff00" },
];

/** The blob with its data chunk re-encoded as a zstd frame of raw blocks (the reader only reads a deflated schema chunk). */
async function zstdFig(canvas: Buffer, declare: boolean): Promise<Buffer> {
  const [schema, data] = parseFigKiwiChunks(canvas)!;
  return kiwiBlobOf(canvas, [Buffer.from(schema!), rawZstdFrame(await decompressFigKiwiDataAsync(data!), declare)]);
}

describe("zstd chunk streaming cap", () => {
  const bombBlob = (canvas: Buffer): Buffer => kiwiBlobOf(canvas, [rleBombFrame(40)]);

  it("refuses a frame that declares a small size but expands past the cap", async () => {
    const canvas = await bareFig(RECTS);
    await assert.rejects(loadDesignSource("z.fig", bombBlob(canvas), { maxFigChunkBytes: 2_000_000 }), CAP_ERROR);
  });

  it("loads valid zstd chunks with and without a declared content size", async () => {
    const canvas = await bareFig(RECTS);
    const expected = (await loadDesignSource("f.fig", canvas)).doc;
    for (const declare of [false, true]) {
      const blob = await zstdFig(canvas, declare);
      assert.deepEqual((await loadDesignSource("f.fig", blob)).doc, expected, `declared: ${declare}`);
    }
  });

  it("concatenates the output parts of an undeclared-size frame longer than its window", () => {
    const data = Buffer.alloc(3 * 1024 * 1024 + 123);
    for (let i = 0; i < data.length; i++) data[i] = (i * 31 + (i >> 8)) & 0xff;
    const out = decompressChunkCapped(rawZstdFrame(data, false), data.length + 1, () => assert.fail("over"));
    assert.ok(out);
    assert.equal(Buffer.compare(Buffer.from(out), data), 0);
  });

  it("refuses a frame whose window descriptor passes the cap, before decompressing it", async () => {
    const canvas = await bareFig(RECTS);
    for (const window of [0xf8, 0xa0]) {
      const frame = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, window, 0x01, 0x00, 0x00]);
      await assert.rejects(loadDesignSource("w.fig", kiwiBlobOf(canvas, [frame])), CAP_ERROR, `window byte ${window}`);
    }
  });

  it("reports a corrupt zstd chunk as an Invalid .fig document", async () => {
    const canvas = await bareFig(RECTS);
    const reserved = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00, 0x07, 0x00, 0x00]);
    const garbage = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00, 0x25, 0x00, 0x00, 0xde, 0xad, 0xbe, 0xef]);
    for (const frame of [reserved, garbage]) {
      await assert.rejects(loadDesignSource("c.fig", kiwiBlobOf(canvas, [frame, frame])), (err: Error) => /^Invalid \.fig document: /.test(err.message));
    }
  });
});

describe("kiwi chunk cap in bare and zipped files", () => {
  const bomb = deflateRawSync(Buffer.alloc(1_000_000));

  it("refuses a bare blob whose chunk inflates past the cap", async () => {
    const canvas = await bareFig(RECTS);
    await assert.rejects(loadDesignSource("b.fig", kiwiBlobOf(canvas, [bomb]), { maxFigChunkBytes: 100_000 }), CAP_ERROR);
  });

  it("refuses a stored zip entry whose kiwi chunk inflates past the cap", async () => {
    const canvas = await bareFig(RECTS);
    const zip = zipFig(kiwiBlobOf(canvas, [bomb]));
    await assert.rejects(loadDesignSource("s.fig", zip, { maxFigChunkBytes: 100_000 }), CAP_ERROR);
  });

  it("refuses a deflated zip entry whose kiwi chunk inflates past the cap", async () => {
    const canvas = await bareFig(RECTS);
    const zip = storedZip([{ name: "canvas.fig", data: deflateRawSync(kiwiBlobOf(canvas, [bomb])) }]);
    zip.writeUInt16LE(8, zip.readUInt32LE(zip.length - 6) + 10);
    await assert.rejects(loadDesignSource("d.fig", zip, { maxFigChunkBytes: 100_000 }), CAP_ERROR);
  });

  it("refuses a zstd bomb inside a zip entry", async () => {
    const canvas = await bareFig(RECTS);
    const zip = zipFig(kiwiBlobOf(canvas, [rleBombFrame(40)]));
    await assert.rejects(loadDesignSource("z.fig", zip, { maxFigChunkBytes: 2_000_000 }), CAP_ERROR);
  });
});

describe("one capped decompression and one decode per load", () => {
  const spies = () => {
    const decompressed: Uint8Array[] = [];
    const decodes: number[] = [];
    const parses: number[] = [];
    return {
      decompressed,
      decodes,
      parses,
      seams: {
        decompress: (chunk: Uint8Array, cap: number, over: () => never) => {
          decompressed.push(chunk);
          return decompressChunkCapped(chunk, cap, over);
        },
        decode: (data: Uint8Array) => {
          decodes.push(data.length);
          return decodeMessage(data);
        },
        parse: async (buffer: ArrayBuffer) => {
          parses.push(buffer.byteLength);
          return parseFigFile(buffer);
        },
      },
    };
  };

  it("decompresses each chunk once and decodes once for a bare and a zipped file", async () => {
    const canvas = await bareFig(RECTS);
    const chunkCount = parseFigKiwiChunks(canvas)!.length;
    for (const [label, bytes] of [["bare", canvas], ["zipped", zipFig(canvas)]] as const) {
      const spy = spies();
      const source = await loadFig("f.fig", bytes, {}, spy.seams);
      assert.equal(source.format, "fig");
      assert.equal(spy.decompressed.length, chunkCount, label);
      assert.equal(new Set(spy.decompressed).size, chunkCount, label);
      assert.equal(spy.decodes.length, 1, label);
      assert.equal(spy.parses.length, 1, label);
    }
  });

  it("fails an over-cap file before the reader is invoked", async () => {
    const canvas = await bareFig(RECTS);
    for (const bytes of [canvas, zipFig(canvas)]) {
      const spy = spies();
      await assert.rejects(loadFig("f.fig", bytes, { maxFigChunkBytes: 100 }, spy.seams), CAP_ERROR);
      assert.equal(spy.parses.length, 0);
    }
  });
});

describe("figGuids pairing", () => {
  const node = (id: string, sourceId?: string): SceneNode => ({ id, type: "FRAME", internalOnly: false, source: sourceId === undefined ? {} : { id: sourceId } }) as unknown as SceneNode;
  const change = (guid: string, parent: string, position: string) => {
    const key = (k: string) => ({ sessionID: Number(k.split(":")[0]), localID: Number(k.split(":")[1]) });
    return { guid: key(guid), parentIndex: { guid: key(parent), position } };
  };
  const stub = (tree: Record<string, SceneNode[]>, pages: SceneNode[]): SceneGraph => ({ getPages: () => pages, getChildren: (id: string) => tree[id] ?? [] }) as unknown as SceneGraph;

  it("leaves out every child of a parent whose kid's source.id disagrees with its paired change", () => {
    const page = node("page", "0:1");
    const [p, q, x, y, z, k1, k2] = [node("p"), node("q"), node("x", "9:9"), node("y"), node("z"), node("k1", "1:5"), node("k2")];
    const graph = stub({ page: [p, q], p: [x, y], y: [z], q: [k1, k2] }, [page]);
    const changes = [
      change("1:1", "0:1", "a"),
      change("1:2", "0:1", "b"),
      change("1:3", "1:1", "a"),
      change("1:4", "1:1", "b"),
      change("1:7", "1:4", "a"),
      change("1:5", "1:2", "a"),
      change("1:6", "1:2", "b"),
    ];
    assert.deepEqual([...figGuids(graph, changes)], [["page", "0:1"], ["p", "1:1"], ["q", "1:2"], ["k1", "1:5"], ["k2", "1:6"]]);
  });
});

describe("emitted id map", () => {
  it("binds a doc id to the emitted fallback-id node, not a never-emitted clone with a real source.id", () => {
    const g = new SceneGraph();
    const page = g.getPages()[0]!;
    const emittedFrame = g.createNodeWithId("1:5", "FRAME", page.id, { name: "Emitted" });
    const comp = g.createNodeWithId("1:900", "COMPONENT", page.id, { name: "Comp" });
    const instance = g.createNodeWithId("1:901", "INSTANCE", page.id, { name: "Inst", componentId: comp.id });
    const clone = g.createNodeWithId("1:902", "FRAME", instance.id, { name: "Clone" });
    clone.source = { id: "1:5" } as SceneNode["source"];

    const emitted: Array<[string, string]> = [];
    figSceneToPen(g, new Map(), emitted);
    assert.ok(!emitted.some(([, graphId]) => graphId === clone.id), "the clone is never emitted");
    assert.deepEqual([...emittedIdMap(emitted)].filter(([doc]) => doc === "1:5"), [["1:5", emittedFrame.id]]);
  });
});
