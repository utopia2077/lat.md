import { statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { toPosix } from './path.js';
import {
  LAT_CONFIG_FILE,
  latDirEnvError,
  latticeDirName,
  latticeExcludePaths,
  readLatProjectConfig,
} from './project-config.js';

// Vault layout is one concern: consumers that resolve or describe the vault
// import from here, and only this module reaches into project-config directly.
export {
  DEFAULT_LATTICE_DIR_NAME,
  LAT_CONFIG_FILE,
  LAT_DIR_ENV,
  latDirEnvError,
  latticeDirName,
  latticeExcludePaths,
  readLatProjectConfig,
  validateLatticeDirName,
  type LatProjectConfig,
} from './project-config.js';

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Find the nearest ancestor containing the project's vault directory.
 *
 * The vault name comes from {@link latticeDirName} at every level: the `LAT_DIR`
 * override, then that level's `lat.config.json`, then the `lat.md` default. A
 * level that has a config file is authoritative — it does not also fall back to
 * `lat.md`, so a half-finished migration cannot silently select the old vault.
 * The walk continues to the parent when the configured directory is absent,
 * which is what nested packages in a monorepo need.
 */
export function findLatticeDir(from?: string): string | null {
  let dir = resolve(from ?? process.cwd());
  while (true) {
    const candidate = resolve(dir, latticeDirName(dir));
    if (isDirectory(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Find the root of the nearest project containing a vault directory. */
export function findProjectRoot(from?: string): string | null {
  const latDir = findLatticeDir(from);
  return latDir ? dirname(latDir) : null;
}

/**
 * The vault's path relative to the project root, in POSIX form. This is the
 * source of truth for section-id and route prefixes because it uses exactly the
 * same `relative()` derivation as section ids themselves, so a renamed vault
 * needs no ID rewriting. Not the same as `basename`: the two coincide only for a
 * vault directly under the project root.
 */
export function latticeDirRel(
  latDir: string,
  projectRoot = dirname(latDir),
): string {
  return toPosix(relative(projectRoot, latDir));
}

/** `latticeDirRel` with a trailing slash, or `''` — the literal `'lat.md/'` replacement. */
export function latticePathPrefix(
  latDir: string,
  projectRoot = dirname(latDir),
): string {
  const rel = latticeDirRel(latDir, projectRoot);
  return rel ? `${rel}/` : '';
}

/**
 * Name of a directory's index file: the directory's own name plus `.md`
 * (unless it already ends in `.md`). `checkIndex` validates that this file
 * exists and lists every sibling, so every consumer that needs to locate the
 * index by name — external-source config, `lat paths`, view diagnostics — must
 * derive it here rather than assuming `lat.md`.
 */
export function latticeIndexFileName(latDir: string): string {
  const name = basename(latDir);
  return name.endsWith('.md') ? name : `${name}.md`;
}

/**
 * Report a project-configuration problem, if any, without throwing — a
 * malformed config file or an unusable `LAT_DIR` override.
 */
export function projectConfigError(projectRoot: string): string | null {
  const envError = latDirEnvError();
  if (envError) return envError;
  const { error } = readLatProjectConfig(projectRoot);
  return error ? `${join(projectRoot, LAT_CONFIG_FILE)}: ${error}` : null;
}

/** List project Markdown files without loading the Markdown parser. */
export async function listLatticeFiles(latticeDir: string): Promise<string[]> {
  const { walkEntries } = await import('./walk.js');
  const entries = await walkEntries(
    latticeDir,
    latticeExcludePaths(latticeDir),
  );
  return entries
    .filter((entry) => entry.endsWith('.md'))
    .sort()
    .map((entry) => join(latticeDir, entry));
}
