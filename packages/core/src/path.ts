/** Normalize path separators for stable project-relative identities. */
export function toPosix(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * Canonical form of a configured relative path: POSIX separators, no `.` or
 * empty segments. Every consumer of an exclusion list has to agree on this, or
 * a rule like `private/` is honored by the directory walk and ignored by a
 * consumer that matches paths verbatim — and a Windows-style `private\sub`
 * would match nothing at all.
 */
export function normalizeRelativePath(path: string): string {
  return path
    .trim()
    .split(/[\\/]/)
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/');
}
