export type DesignFormat = "pen" | "fig";

/** Design format of `file` by its extension, or undefined when it is not a design file. */
export function designFormatOf(file: string): DesignFormat | undefined {
  if (file.endsWith(".pen")) return "pen";
  if (file.endsWith(".fig")) return "fig";
  return undefined;
}
