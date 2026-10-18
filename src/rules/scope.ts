/** True when a scope entry (`*` glob, whole-string match) matches any of the given ids or names. */
export function matchesScope(scope: readonly string[], ...names: (string | undefined)[]): boolean {
  return scope.some((pattern) => {
    const re = new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    return names.some((n) => n !== undefined && re.test(n));
  });
}
