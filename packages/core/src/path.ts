/** Normalize path separators for stable project-relative identities. */
export function toPosix(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * Canonical form of a configured relative path: no leading `./`, no trailing
 * slash. Every consumer of an exclusion list has to agree on this, or a rule
 * like `private/` is honored by the directory walk and ignored by a consumer
 * that matches paths verbatim.
 */
export function normalizeRelativePath(path: string): string {
  return path.trim().replace(/^\.\//, '').replace(/\/+$/, '');
}
