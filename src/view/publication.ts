import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, relative, sep } from 'node:path';
import {
  normalizeRepositoryPath,
  inspectRepositoryPath,
} from '@lat.md/core/repository-path';
import { walkEntries } from '@lat.md/core/walk';
import {
  latticeDirName,
  latticeExcludePaths,
} from '@lat.md/core/project-discovery';

const exec = promisify(execFile);
const portable = (path: string) => path.split(sep).join('/');

function publicPath(path: string): boolean {
  return path
    .split('/')
    .every(
      (part) =>
        part.toLowerCase() !== 'config.local.yaml' &&
        part.toLowerCase() !== 'node_modules' &&
        !part.startsWith('.'),
    );
}

/**
 * Translate the vault's configured exclusions to project-relative paths: the
 * walk below starts at the project root, but the config names paths inside the
 * vault. Shared by both the git and no-git branches so an excluded document
 * cannot be published just because the checkout has no Git metadata.
 */
function vaultExcludes(projectRoot: string, vaultRel: string): string[] {
  return latticeExcludePaths(join(projectRoot, vaultRel)).map(
    (path) => `${vaultRel}/${path}`,
  );
}

/**
 * True for an excluded path or anything beneath it. The walker prunes excluded
 * directories itself, but the git branch enumerates a flat file list, so it has
 * to apply the prefix rule to each entry.
 */
function isExcludedBy(excluded: readonly string[], path: string): boolean {
  return excluded.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

/** Publication scope is deliberately narrower than interactive source browsing. */
export async function createPublicationPolicy(
  projectRoot: string,
  vaultRel = latticeDirName(projectRoot),
): Promise<(path: string) => Promise<boolean>> {
  let files: string[];
  const git = (args: string[]) =>
    exec('git', ['-c', 'core.fsmonitor=false', ...args], {
      cwd: projectRoot,
      maxBuffer: 50 * 1024 * 1024,
    });
  let tracked: string;
  try {
    tracked = (await git(['ls-files', '--stage', '-z', '--', '.'])).stdout;
  } catch (error) {
    // A directory without Git still has a useful publication policy: honor
    // .gitignore and the ordinary walker exclusions rather than publish all files.
    if (
      (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
      !String((error as { stderr?: string }).stderr).includes(
        'not a git repository',
      )
    )
      throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      for (let directory = projectRoot; ; directory = dirname(directory)) {
        if (existsSync(join(directory, '.git')))
          throw new Error(
            'Git is required to determine publication scope for this checkout',
          );
        if (dirname(directory) === directory) break;
      }
    }
    files = await walkEntries(
      projectRoot,
      vaultExcludes(projectRoot, vaultRel),
    );
    return policy(new Set(files.filter(publicPath)), projectRoot);
  }
  const ignored = new Set(
    (
      await git([
        'ls-files',
        '--cached',
        '--ignored',
        '--exclude-standard',
        '-z',
        '--',
        '.',
      ])
    ).stdout.split('\0'),
  );
  // `git ls-files` honors .gitignore but knows nothing about the vault config,
  // so an excluded path that is tracked would otherwise be published.
  const excluded = vaultExcludes(projectRoot, vaultRel);
  files = tracked.split('\0').flatMap((entry) => {
    const tab = entry.indexOf('\t');
    const mode = entry.slice(0, entry.indexOf(' '));
    if (tab < 0 || !['100644', '100755'].includes(mode)) return [];
    const path = entry.slice(tab + 1);
    return publicPath(path) &&
      !ignored.has(path) &&
      !isExcludedBy(excluded, path)
      ? [path]
      : [];
  });
  return policy(new Set(files), projectRoot);
}

function policy(files: ReadonlySet<string>, root: string) {
  const realRoot = realpath(root);
  return async (authoredPath: string): Promise<boolean> => {
    const path = normalizeRepositoryPath(authoredPath);
    if (!path || path !== authoredPath || !publicPath(path) || !files.has(path))
      return false;
    const inspected = await inspectRepositoryPath(root, path);
    if (inspected.kind !== 'file') return false;
    const real = inspected.realPath;
    // Resolving the root through a platform alias must not change membership.
    const realRelative = portable(relative(await realRoot, real));
    return publicPath(realRelative) && files.has(realRelative);
  };
}
