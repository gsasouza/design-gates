import type { SceneGraph } from "@open-pencil/core";
import type { PenDocument } from "../pen/types.js";
import type { DesignFormat } from "./format.js";

export type { DesignFormat } from "./format.js";

/** A design file loaded in one of the supported formats, behind one format-independent seam. */
export interface DesignSource {
  format: DesignFormat;
  /** Normalized document the diff and the rules work on. */
  doc: PenDocument;
  /**
   * A scene graph ready to render `frameId` with `theme` applied. Every call hands out a graph no
   * earlier render has mutated (measuring, layout, mode selection), so renders are independent.
   */
  sceneFor(frameId: string, theme?: Record<string, string>): Promise<SceneGraph>;
  /** Id in the scene graph of the `doc` node `nodeId`, or undefined when the graph has no such node. */
  graphIdOf(nodeId: string): string | undefined;
}
