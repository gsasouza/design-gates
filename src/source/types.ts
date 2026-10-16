import type { SceneGraph } from "@open-pencil/core";
import type { PenDocument } from "../pen/types.js";
import type { DesignFormat } from "./format.js";

export type { DesignFormat } from "./format.js";

/** A design file loaded in one of the supported formats, behind one format-independent seam. */
export interface DesignSource {
  format: DesignFormat;
  /** Normalized document the diff and the rules work on. */
  doc: PenDocument;
  /** Version of the fig-kiwi format of a `.fig` file; `doc.version` is the `.pen` version it was normalized to. */
  figVersion?: number;
  /**
   * A scene graph ready to render `frameId` with `theme` applied. A `.pen` call hands out a fresh
   * graph; a `.fig` source shares one graph across calls and restores its theme state (active modes,
   * frame mode pins) before each, so the graph must be rendered before the next call and not kept.
   */
  sceneFor(frameId: string, theme?: Record<string, string>): Promise<SceneGraph>;
  /** Id in the scene graph of the `doc` node `nodeId`, or undefined when the graph has no such node. */
  graphIdOf(nodeId: string): string | undefined;
}
