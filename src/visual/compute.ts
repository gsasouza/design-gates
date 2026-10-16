import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChangeBox, DiffDocs, DiffResult, DiffSources } from "../diff/model.js";
import type { Renderer } from "../render/renderer.js";
import { DEFAULT_MIN_AREA, nodeChangeBoxes, pixelChangeBoxes, sortBoxes } from "./change-boxes.js";
import { DEFAULT_THRESHOLD } from "./pixel-diff.js";
import { imagePaths, isRenderable, renderFrameThemes, themeKeysFor } from "./render-frames.js";

export interface FileSystemSeam {
  mkdir(dir: string, opts: { recursive: true }): Promise<unknown>;
  writeFile(file: string, data: Buffer): Promise<void>;
}

export interface VisualDiffOptions {
  result: DiffResult;
  docs: DiffDocs;
  /** Loaded sources behind `docs`; frames are rendered from them when the renderer supports it. */
  sources?: DiffSources;
  renderer: Renderer;
  /** Directory receiving `images/...`; must not be inside the diffed repo. */
  outDir: string;
  /** Device pixels per design pixel. Defaults to 1. */
  scale?: number;
  /** pixelmatch colour threshold. Defaults to 0.1. */
  threshold?: number;
  /** Pixel components smaller than this many pixels are dropped. */
  minArea?: number;
  /** Injected file writes, mainly for tests. */
  fs?: FileSystemSeam;
}

const nodeFs: FileSystemSeam = {
  mkdir: (dir, opts) => mkdir(dir, opts),
  writeFile: (file, data) => writeFile(file, data),
};

const sameBox = (a: ChangeBox, b: ChangeBox): boolean => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/**
 * Render every changed frame (and every frame a variable or theme change lists), write its
 * base/head/diff images under `outDir` and fill `changeBoxes`, `missingBoxes`, `pixelDiffRatio`
 * and `images` of the `result` (which is updated in place and returned).
 */
export async function computeVisualDiff(opts: VisualDiffOptions): Promise<DiffResult> {
  const { result, docs, renderer, outDir } = opts;
  const scale = opts.scale ?? 1;
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const fs = opts.fs ?? nodeFs;

  for (const file of result.files) {
    for (const frame of file.frames) {
      if (!isRenderable(result, file.path, frame)) continue;
      const renders = await renderFrameThemes({
        renderer,
        docs: docs[file.path],
        ...(opts.sources && { sources: opts.sources[file.path] }),
        frame,
        keys: themeKeysFor(result, file.path, frame),
        scale,
        threshold,
      });
      if (!renders.length) continue;

      const first = renders.find((r) => r.key === "default") ?? renders[0]!;
      const { boxes: nodeBoxes, missing } = nodeChangeBoxes(frame.nodes, first.base?.boxes, first.head?.boxes);
      const pixelBoxes: ChangeBox[] = [];
      for (const r of renders) {
        const found = pixelChangeBoxes(r.diff.mask, r.diff.width, r.diff.height, nodeBoxes, {
          minArea: opts.minArea ?? DEFAULT_MIN_AREA,
          rootIds: [frame.id, frame.baseId, frame.headId].filter((id): id is string => !!id),
        });
        for (const b of found) if (!pixelBoxes.some((p) => sameBox(p, b))) pixelBoxes.push(b);
      }
      frame.changeBoxes = sortBoxes([...nodeBoxes, ...pixelBoxes]);
      frame.missingBoxes = missing;
      frame.pixelDiffRatio = Object.fromEntries(renders.map((r) => [r.key, r.diff.ratio]));

      const { images, files } = imagePaths(file.path, frame.id, renders);
      frame.images = images;
      for (const [rel, data] of files) {
        const target = path.join(outDir, ...rel.split("/"));
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, data);
      }
    }
  }
  return result;
}
