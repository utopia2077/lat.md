import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createPublicationPolicy } from '../src/view/publication.js';

const roots: string[] = [];

/** A project whose vault has one publishable file and one excluded file. */
async function createProject(
  exclude: string[],
  { git }: { git: boolean },
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lat-publication-'));
  roots.push(root);
  await mkdir(join(root, 'docs', 'private'), { recursive: true });
  await mkdir(join(root, 'docs', 'public'), { recursive: true });
  await writeFile(
    join(root, 'lat.config.json'),
    JSON.stringify({ dir: 'docs', exclude }),
  );
  await writeFile(
    join(root, 'docs', 'docs.md'),
    'The index for this vault.\n\n- [[public/public]] — Visible\n',
  );
  await writeFile(
    join(root, 'docs', 'public', 'public.md'),
    '# Public\n\nA publishable document.\n',
  );
  await writeFile(
    join(root, 'docs', 'private', 'secret.md'),
    '# Secret\n\nAn excluded document.\n',
  );
  if (git) {
    const run = (...args: string[]) =>
      execFileSync(
        'git',
        ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
        { cwd: root, stdio: 'ignore' },
      );
    run('init', '-q', '.');
    run('add', '-A');
    run('commit', '-qm', 'init');
  }
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

// @lat: [[tests/project-config#Project Configuration#Excluded vault paths#Keeps excluded paths out of the published site]]
it.each([
  ['a bare name', 'private'],
  ['a trailing slash', 'private/'],
  ['a leading ./', './private'],
])('keeps an excluded path out of publication given %s', async (_l, spelling) => {
  // The git branch enumerates a flat `ls-files` list, so it cannot rely on the
  // walker's normalization — every spelling has to mean the same thing.
  for (const git of [true, false]) {
    const root = await createProject([spelling], { git });
    const policy = await createPublicationPolicy(root, 'docs');
    expect(await policy('docs/private/secret.md')).toBe(false);
    expect(await policy('docs/public/public.md')).toBe(true);
    expect(await policy('docs/docs.md')).toBe(true);
  }
});

it('publishes an excluded path when the config does not name it', async () => {
  const root = await createProject([], { git: true });
  const policy = await createPublicationPolicy(root, 'docs');
  expect(await policy('docs/private/secret.md')).toBe(true);
});
