import type {
  ChangeBox,
  DiffResult,
  FileDiff,
  FrameDiff,
  FrameRef,
  NodeChange,
  ThemeChange,
  VariableChange,
} from "./model.js";

const CHANGE_ORDER = ["added", "removed", "modified", "moved", "reordered"];

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function byKey<T>(items: readonly T[], ...keys: ((item: T) => string)[]): T[] {
  return [...items].sort((a, b) => {
    for (const key of keys) {
      const c = cmp(key(a), key(b));
      if (c !== 0) return c;
    }
    return 0;
  });
}

/** Sorted keys, with "default" first. */
function themeRecord<V>(
  record: Record<string, V> | null,
  map: (value: V) => unknown = (v) => v,
): Record<string, unknown> | null {
  if (record === null) return null;
  const keys = Object.keys(record).sort((a, b) =>
    a === "default" ? (b === "default" ? 0 : -1) : b === "default" ? 1 : cmp(a, b),
  );
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = map(record[k]!);
  return out;
}

/** Recursively sorts plain object keys so arbitrary values (props, variable values) are stable. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = canonical((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

function node(n: NodeChange): unknown {
  return {
    id: n.id,
    name: n.name,
    type: n.type,
    change: n.change,
    ...(n.props && { props: n.props.map((p) => ({ path: p.path, old: canonical(p.old), new: canonical(p.new) })) }),
    ...(n.from !== undefined && { from: n.from }),
    ...(n.to !== undefined && { to: n.to }),
  };
}

function box(b: ChangeBox): unknown {
  return {
    x: b.x,
    y: b.y,
    w: b.w,
    h: b.h,
    kind: b.kind,
    side: b.side,
    ...(b.nodeId !== undefined && { nodeId: b.nodeId }),
    ...(b.name !== undefined && { name: b.name }),
  };
}

function frame(f: FrameDiff): unknown {
  return {
    id: f.id,
    name: f.name,
    ...(f.baseId !== undefined && { baseId: f.baseId }),
    ...(f.headId !== undefined && { headId: f.headId }),
    status: f.status,
    matchedBy: f.matchedBy,
    counts: {
      added: f.counts.added,
      removed: f.counts.removed,
      modified: f.counts.modified,
      moved: f.counts.moved,
      reordered: f.counts.reordered,
    },
    nodes: byKey(f.nodes, (n) => n.id, (n) => String(CHANGE_ORDER.indexOf(n.change)).padStart(2, "0")).map(node),
    changeBoxes: f.changeBoxes.map(box),
    missingBoxes: [...f.missingBoxes].sort(cmp),
    pixelDiffRatio: themeRecord(f.pixelDiffRatio),
    images: themeRecord(f.images, (i) => ({
      ...(i.base !== undefined && { base: i.base }),
      ...(i.head !== undefined && { head: i.head }),
      ...(i.diff !== undefined && { diff: i.diff }),
    })),
  };
}

function file(f: FileDiff): unknown {
  return {
    path: f.path,
    ...(f.oldPath !== undefined && { oldPath: f.oldPath }),
    status: f.status,
    ...(f.format !== undefined && f.format !== "pen" && { format: f.format }),
    frames: byKey(f.frames, (x) => x.id).map(frame),
  };
}

const frameRefs = (refs: FrameRef[]): unknown[] =>
  byKey(refs, (r) => r.file, (r) => r.frameId).map((r) => ({ file: r.file, frameId: r.frameId }));

function variable(v: VariableChange): unknown {
  return {
    file: v.file,
    name: v.name,
    change: v.change,
    ...(v.theme !== undefined && { theme: v.theme }),
    ...("old" in v && { old: canonical(v.old) }),
    ...("new" in v && { new: canonical(v.new) }),
    frames: frameRefs(v.frames),
  };
}

function theme(t: ThemeChange): unknown {
  return { file: t.file, name: t.name, change: t.change, frames: frameRefs(t.frames) };
}

/** Deterministic JSON for a diff result: stable ordering and key order, 2-space indent, trailing newline. */
export function serializeDiff(result: DiffResult): string {
  const out = {
    schemaVersion: result.schemaVersion,
    base: { ref: result.base.ref, sha: result.base.sha },
    head: { ref: result.head.ref, sha: result.head.sha },
    files: byKey(result.files, (f) => f.path).map(file),
    variables: byKey(result.variables, (v) => v.file, (v) => v.name, (v) => v.theme ?? "").map(variable),
    themes: byKey(result.themes, (t) => t.file, (t) => t.name).map(theme),
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}
