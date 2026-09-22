import { readdir, readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error -- no type declarations
import walk from 'ignore-walk';
import { normalizeRelativePath } from './path.js';

type IgnoreWalkerOptions = {
  path: string;
  parent?: IgnoreWalkerInstance;
  ignoreFiles: string[];
  exact?: boolean;
};

type IgnoreWalkerInstance = {
  filterEntry(
    entry: string,
    partial?: boolean,
    entryBasename?: string,
  ): boolean;
  onReadIgnoreFile(file: string, data: string, done: () => void): void;
};

type IgnoreWalkerConstructor = new (
  options: IgnoreWalkerOptions,
) => IgnoreWalkerInstance;

const IgnoreWalker = (walk as unknown as { Walker: IgnoreWalkerConstructor })
  .Walker;

/** Dependency trees are never project source, even without ignore metadata. */
export const ALWAYS_IGNORED_DIRECTORIES = ['node_modules'] as const;

class IgnoreContext extends IgnoreWalker {
  filterEntry(
    entry: string,
    partial?: boolean,
    entryBasename?: string,
  ): boolean {
    const candidate = entryBasename ?? entry;
    if (
      candidate
        .split(/[\\/]/)
        .some(
          (part) =>
            ALWAYS_IGNORED_DIRECTORIES.includes(
              part as (typeof ALWAYS_IGNORED_DIRECTORIES)[number],
            ) ||
            (part.startsWith('.') && part !== '.' && part !== '..'),
        )
    ) {
      return false;
    }
    return super.filterEntry(entry, partial, entryBasename);
  }
}

type DirectoryJob = {
  path: string;
  relativePath: string;
  ignoreContext: IgnoreWalkerInstance;
};

type DirectoryResult = {
  directories: DirectoryJob[];
  files: string[];
};

async function readDirectory(
  job: DirectoryJob,
  excluded: ReadonlySet<string>,
): Promise<DirectoryResult> {
  const entries = await readdir(job.path, { withFileTypes: true });
  if (entries.some((entry) => entry.name === '.gitignore')) {
    const rules = await readFile(join(job.path, '.gitignore'), 'utf8');
    job.ignoreContext.onReadIgnoreFile('.gitignore', rules, () => {});
  }

  const directories: DirectoryJob[] = [];
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;

    // Prune an excluded directory outright: its whole subtree is out of scope,
    // so there is no reason to descend into it.
    const relativePath = job.relativePath
      ? `${job.relativePath}/${entry.name}`
      : entry.name;
    if (excluded.has(relativePath)) continue;

    if (entry.isDirectory()) {
      const passDirectory = job.ignoreContext.filterEntry(entry.name, true);
      if (!passDirectory) continue;
      const passFile = job.ignoreContext.filterEntry(entry.name);
      const path = join(job.path, entry.name);
      directories.push({
        path,
        relativePath,
        ignoreContext: new IgnoreContext({
          path,
          parent: job.ignoreContext,
          ignoreFiles: ['.gitignore'],
          exact: passFile || job.ignoreContext.filterEntry(`${entry.name}/`),
        }),
      });
    } else if (job.ignoreContext.filterEntry(entry.name)) {
      files.push(relativePath);
    }
  }

  return { directories, files };
}

async function walkWithDirectoryPool(
  root: DirectoryJob,
  excluded: ReadonlySet<string>,
): Promise<string[]> {
  const queue = [root];
  const files: string[] = [];
  const workerLimit = availableParallelism();
  let nextJob = 0;
  let activeWorkers = 0;

  return new Promise((resolve, reject) => {
    let settled = false;

    const schedule = (): void => {
      if (settled) return;

      while (activeWorkers < workerLimit && nextJob < queue.length) {
        const job = queue[nextJob++];
        activeWorkers++;
        void readDirectory(job, excluded).then(
          (result) => {
            files.push(...result.files);
            queue.push(...result.directories);
            activeWorkers--;

            if (activeWorkers === 0 && nextJob === queue.length) {
              settled = true;
              files.sort((a, b) => a.localeCompare(b, 'en'));
              resolve(files);
            } else {
              schedule();
            }
          },
          (error: unknown) => {
            if (settled) return;
            settled = true;
            reject(error);
          },
        );
      }
    };

    schedule();
  });
}

/** Normalize configured exclude paths to the walked dir's relative POSIX form. */
function normalizeExcludes(exclude: readonly string[]): Set<string> {
  const normalized = new Set<string>();
  for (const entry of exclude) {
    const path = normalizeRelativePath(entry);
    if (path) normalized.add(path);
  }
  return normalized;
}

/**
 * Walk a directory tree respecting nested .gitignore rules. Directories are
 * consumed through a bounded queue, and each completed job submits its visible
 * children back to the pool. Returns sorted project-relative POSIX paths.
 *
 * This is the single entry point for all directory walking in lat.md — both
 * code-ref scanning and lat.md/ index validation use it so .gitignore rules
 * are consistently honored.
 *
 * `exclude` holds paths relative to `dir`; naming a directory prunes its whole
 * subtree. It is the explicit counterpart to a `.gitignore` rule: it applies
 * whether or not the project is a Git checkout, and whether or not the paths it
 * names are committed.
 */
export function walkEntries(
  dir: string,
  exclude: readonly string[] = [],
): Promise<string[]> {
  return walkWithDirectoryPool(
    {
      path: dir,
      relativePath: '',
      ignoreContext: new IgnoreContext({
        path: dir,
        ignoreFiles: ['.gitignore'],
      }),
    },
    normalizeExcludes(exclude),
  );
}

/**
 * Normalize a filesystem path to forward-slash (POSIX) form. Node's
 * `path.relative()` emits the native separator (`\` on Windows), but section
 * ids, wiki-link targets, and the code-ref data model are all forward-slash
 * based. Normalizing every OS-relative path through here at construction keeps
 * a single invariant — stored paths are always POSIX — so downstream lookups
 * (e.g. `buildFileIndex`, ref resolution) work identically on every platform.
 */
