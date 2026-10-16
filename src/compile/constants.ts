/** `.pen` document versions this tool understands. */
export const KNOWN_VERSIONS: readonly string[] = ["2.6"];

/** Fig-kiwi versions of `.fig` files this tool understands (`DesignSource.figVersion`). */
export const KNOWN_FIG_VERSIONS: readonly number[] = [101];

/** Node `type`s of the `.pen` format; anything else is an SCH-001 diagnostic. */
export const KNOWN_TYPES: readonly string[] = [
  "context",
  "ellipse",
  "frame",
  "group",
  "icon_font",
  "line",
  "note",
  "path",
  "polygon",
  "prompt",
  "rectangle",
  "ref",
  "text",
];

/** Deepest node nesting compiled (source tree and expanded instances alike). */
export const MAX_DEPTH = 128;
/** Deepest chain of nested instances expanded. */
export const MAX_REF_DEPTH = 32;
/** Most compiled nodes per document, so nested instances cannot fan out exponentially. */
export const MAX_COMPILED_NODES = 100_000;
/** Deepest property value walked for variable references. */
export const MAX_PROP_DEPTH = 32;
/** Most theme combinations listed. */
export const MAX_THEME_COMBINATIONS = 1000;
