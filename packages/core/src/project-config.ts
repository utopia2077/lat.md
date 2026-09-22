import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { normalizeRelativePath } from './path.js';

/**
 * Project-level configuration, read from the project root — never from inside
 * the vault. Discovery has to know where the vault is before it can read
 * anything the vault contains, so the file that names the vault cannot live in
 * it. The vault's own machine-local settings stay in `<vault>/config.local.yaml`.
 */
export const LAT_CONFIG_FILE = 'lat.config.json';

/** Vault directory name assumed when nothing configures one. */
export const DEFAULT_LATTICE_DIR_NAME = 'lat.md';

/**
 * Ad-hoc vault override, resolved relative to each directory the discovery walk
 * visits (so a command started in a subdirectory still finds the project). It
 * is never persisted — `lat init` does not fold it into the config file.
 */
export const LAT_DIR_ENV = 'LAT_DIR';

export type LatProjectConfig = {
  /**
   * Vault directory, relative to the project root. Deliberately one path
   * segment: `src/view/source-target.ts` builds synthetic URLs of the form
   * `/project/<vault>/<path>` whose depth has to match the real project-relative
   * path, and the vault's index file is named after its directory.
   */
  dir?: string;
  /**
   * Vault-relative paths kept out of the graph. Naming a directory prunes its
   * whole subtree, so excluded files are absent from validation, indexing, and
   * the browser alike.
   */
  exclude?: string[];
  /**
   * Extra words for the CJK segmenter's dictionary. A term the dictionary does
   * not know is split into its parts, which turns an exact-term search into a
   * fuzzy one; naming it here keeps it whole.
   */
  'segmenter-words'?: string[];
};

export type LatProjectConfigResult = {
  config: LatProjectConfig;
  /** Human-readable problem with the file, or null. Discovery never throws on it. */
  error: string | null;
};

const EMPTY: LatProjectConfigResult = { config: {}, error: null };

/**
 * Validate a vault directory name, returning a human-readable problem or null.
 * The rules are shared by config parsing and `lat init --vault` so a name that
 * one accepts cannot be rejected by the other.
 */
export function validateLatticeDirName(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string') return 'must be a string';
  if (!value) return 'must not be empty';
  if (isAbsolute(value)) return 'must be relative to the project root';
  if (value.includes('/') || value.includes('\\'))
    return 'must be a single directory name, not a path';
  if (value.startsWith('.'))
    return 'must not start with a dot — directory walking skips dot entries';
  return null;
}

function validateDir(value: unknown): string | null {
  const problem = validateLatticeDirName(value);
  return problem === null ? null : `"dir" ${problem}`;
}

/**
 * Segmenter tokens are runs of letters, digits, and underscores — the same
 * shape the tokenizer extracts. Anything else can never match one, so a word
 * with punctuation or whitespace would validate and then do nothing.
 *
 * The word must also contain a Han character. Only Han runs are split by the
 * tokenizer, so an entry for any other script would likewise do nothing: a
 * Latin run is already one token, and the segmenter has no dictionary for kana
 * or hangul.
 */
function validateSegmenterWord(value: string): string | null {
  if (!value.trim()) return 'must not be empty';
  if (!/^[\p{L}\p{N}_]+$/u.test(value))
    return 'must be a single word of letters, digits, or underscores';
  if (!/\p{Script=Han}/u.test(value))
    return 'must contain a Han character, since only Han text is segmented';
  return null;
}

/**
 * An excluded path is relative to the vault, so an absolute path or a `..`
 * segment would silently widen the exclusion to directories the config has no
 * business reaching into.
 */
function validateExcludeEntry(value: string): string | null {
  if (!value.trim()) return 'must not be empty';
  if (isAbsolute(value)) return 'must be relative to the vault directory';
  if (value.split(/[\\/]/).includes('..')) return 'must not contain ".."';
  return null;
}

/**
 * Read and validate `<root>/lat.config.json`. Does not walk, does not write, and
 * exposes no on-disk cache: `tests/paths.test.ts` asserts a CLI run leaves the
 * project's directory listing untouched.
 */
export function readLatProjectConfig(
  projectRoot: string,
): LatProjectConfigResult {
  const path = join(projectRoot, LAT_CONFIG_FILE);
  if (!existsSync(path)) return EMPTY;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    return {
      config: {},
      error: `invalid JSON: ${(error as Error).message}`,
    };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { config: {}, error: 'expected a JSON object' };

  const record = raw as Record<string, unknown>;
  const dirError = validateDir(record.dir);
  if (dirError) return { config: {}, error: dirError };

  if (record.exclude !== undefined && !Array.isArray(record.exclude))
    return { config: {}, error: '"exclude" must be an array of strings' };
  if (Array.isArray(record.exclude)) {
    for (const entry of record.exclude as unknown[]) {
      if (typeof entry !== 'string')
        return { config: {}, error: '"exclude" must be an array of strings' };
      const problem = validateExcludeEntry(entry);
      if (problem) return { config: {}, error: `"exclude" entry ${problem}` };
    }
  }

  const words = record['segmenter-words'];
  if (words !== undefined) {
    if (!Array.isArray(words))
      return {
        config: {},
        error: '"segmenter-words" must be an array of strings',
      };
    for (const word of words as unknown[]) {
      if (typeof word !== 'string')
        return {
          config: {},
          error: '"segmenter-words" must be an array of strings',
        };
      const problem = validateSegmenterWord(word);
      if (problem)
        return { config: {}, error: `"segmenter-words" entry ${problem}` };
    }
  }

  const config: LatProjectConfig = {};
  if (typeof record.dir === 'string') config.dir = record.dir;
  if (Array.isArray(record.exclude))
    config.exclude = record.exclude as string[];
  if (Array.isArray(words)) config['segmenter-words'] = words as string[];
  return { config, error: null };
}

/**
 * Vault directory name for `projectRoot`: the `LAT_DIR` override wins, then the
 * project config, then the historical default. Never throws, so an agent hook
 * survives a typo in the config file; command entry points surface the problem
 * through {@link projectConfigError} instead.
 */
export function latticeDirName(projectRoot: string): string {
  const override = process.env[LAT_DIR_ENV]?.trim();
  if (override && validateLatticeDirName(override) === null) return override;
  return (
    readLatProjectConfig(projectRoot).config.dir ?? DEFAULT_LATTICE_DIR_NAME
  );
}

/**
 * Problem with the `LAT_DIR` override, or null. An invalid value is ignored by
 * {@link latticeDirName} — discovery must not fail on an environment variable —
 * so the CLI entry points report it here instead of silently using a different
 * vault than the one the variable asked for.
 */
export function latDirEnvError(): string | null {
  const override = process.env[LAT_DIR_ENV]?.trim();
  if (!override) return null;
  const problem = validateLatticeDirName(override);
  return problem ? `${LAT_DIR_ENV} ${problem}` : null;
}

/**
 * Vault-relative paths the project config keeps out of the graph. The vault's
 * parent is where its config lives, since `dir` is a single path segment.
 */
export function latticeExcludePaths(latDir: string): readonly string[] {
  const entries = readLatProjectConfig(dirname(latDir)).config.exclude ?? [];
  // Normalize here rather than at each consumer: the walker and the publication
  // policy match paths differently, and an unnormalized `private/` would be
  // honored by one and ignored by the other.
  return entries.map(normalizeRelativePath).filter((entry) => entry.length > 0);
}

/** Glossary words the project adds to the CJK segmenter's dictionary. */
export function latticeSegmenterWords(latDir: string): readonly string[] {
  return readLatProjectConfig(dirname(latDir)).config['segmenter-words'] ?? [];
}
