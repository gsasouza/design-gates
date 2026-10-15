import type { PenDocument } from "../pen/types.js";

/** Axis-aligned box in frame pixel coordinates (origin at the frame's top-left). */
export interface NodeBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RenderOptions {
  /** Device pixels per design pixel. */
  scale: number;
  /** Theme selection (axis -> value, e.g. { mode: "dark" }) applied to the frame. */
  theme?: Record<string, string>;
}

export interface RenderResult {
  png: Buffer;
  width: number;
  height: number;
  /** Laid-out bounding box of every node in the frame (the frame included), keyed by node id. */
  nodeBoxes: Record<string, NodeBox>;
}

export interface Renderer {
  renderFrame(
    doc: PenDocument,
    frameId: string,
    opts: { scale: number; theme?: Record<string, string> },
  ): Promise<{
    png: Buffer;
    width: number;
    height: number;
    nodeBoxes: Record<string, { x: number; y: number; w: number; h: number }>;
  }>;
}
