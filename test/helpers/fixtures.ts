// Tests run from dist/test/helpers/, so the repo root is three levels up
// (from the source file test/helpers/ it would be two).
/** Repo `fixtures/` directory, independent of the working directory. */
export const fixturesDir = new URL("../../../fixtures/", import.meta.url);

export function fixtureUrl(name: string): URL {
  return new URL(name, fixturesDir);
}
