import { fileURLToPath } from "node:url";
import { compile, loadPenFile, type CompiledDocument, type CompiledNode } from "../../src/index.js";
import { fixtureUrl } from "./fixtures.js";

export const gateFixture = (name: string): string => fileURLToPath(fixtureUrl(`gates/${name}`));

export async function compileFixture(name: string): Promise<CompiledDocument> {
  return compile(await loadPenFile(gateFixture(name)), { file: name });
}

export function node(compiled: CompiledDocument, id: string): CompiledNode {
  const found = compiled.nodes.find((n) => n.id === id);
  if (!found) throw new Error(`no compiled node ${id}; have ${compiled.nodes.map((n) => n.id).join(", ")}`);
  return found;
}
