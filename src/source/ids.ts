/**
 * Graph id by document id for the nodes the normalizer emitted, from its `[doc id, graph id]`
 * record. Nodes it never emits (instance-subtree clones) are not in the record, so they cannot take
 * an emitted node's id. Throws on two emitted nodes with the same id.
 */
export function emittedIdMap(emitted: readonly (readonly [string, string])[]): Map<string, string> {
  const ids = new Map<string, string>();
  for (const [docId, graphId] of emitted) {
    if (ids.has(docId)) throw new Error(`two nodes with the id ${docId}`);
    ids.set(docId, graphId);
  }
  return ids;
}
