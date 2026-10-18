const PREFIX = "$var:";

/** Synthetic node id used by findings that target a variable rather than a node. */
export function variableNodeId(name: string): string {
  return `${PREFIX}${name}`;
}

export function isVariableNodeId(id: string): boolean {
  return id.startsWith(PREFIX);
}
