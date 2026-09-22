import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findLatticeDir,
  latticeDirRel,
  latticeIndexFileName,
  latticePathPrefix,
  listLatticeFiles,
} from '@lat.md/core/project-discovery';
import {
  DEFAULT_LATTICE_DIR_NAME,
  latDirEnvError,
  latticeDirName,
  latticeExcludePaths,
  readLatProjectConfig,
  validateLatticeDirName,
} from '@lat.md/core/project-config';
import { getRemoteSelection } from '@lat.md/core/config';
import { checkIndex, checkMd } from '@lat.md/core/cli/check';
import { scanCodeRefs } from '@lat.md/core/code-refs';
import { flattenSections, loadAllSections } from '@lat.md/core/lattice';

const roots: string[] = [];

/** Build a `@lat:` comment without letting the scanner match this file. */
function codeReference(comment: string, target: string): string {
  return `${comment} @${'lat'}: [[${target}]]\n`;
}

async function createProject(
  files: Record<string, string>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lat-project-config-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(join(absolute, '..'), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

/** A minimal, valid vault under `docs/` plus one source file linking back. */
function docsVaultFiles(config: string | null): Record<string, string> {
  return {
    ...(config === null ? {} : { 'lat.config.json': config }),
    'docs/docs.md':
      'This directory defines the high-level concepts of this project.\n\n- [[architecture]] — System architecture\n',
    'docs/architecture.md':
      '# Architecture\n\nHow the system is put together.\n\n## Request Pipeline\n\nThe end-to-end request path.\n',
    // Split so the scanner does not read this fixture as a real code ref.
    'src/app.ts': `${codeReference('//', 'docs/architecture#Request Pipeline')}export function handleRequest() { return 1; }\n`,
  };
}

beforeEach(() => {
  delete process.env.LAT_DIR;
  delete process.env.LAT_LLM_BASE_URL;
  delete process.env.LAT_LLM_MODEL;
});

afterEach(async () => {
  delete process.env.LAT_DIR;
  delete process.env.LAT_LLM_BASE_URL;
  delete process.env.LAT_LLM_MODEL;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('project config', () => {
  // @lat: [[tests/project-config#Project Configuration#Project config#Reads and validates the vault directory]]
  it('defaults to lat.md when no config file is present', async () => {
    const root = await createProject({});
    expect(readLatProjectConfig(root)).toEqual({ config: {}, error: null });
    expect(latticeDirName(root)).toBe(DEFAULT_LATTICE_DIR_NAME);
  });

  it('reads a configured directory and preserves an exclude list', async () => {
    const root = await createProject({
      'lat.config.json': JSON.stringify({
        dir: 'docs',
        exclude: ['private'],
      }),
    });
    expect(readLatProjectConfig(root)).toEqual({
      config: { dir: 'docs', exclude: ['private'] },
      error: null,
    });
    expect(latticeDirName(root)).toBe('docs');
  });

  // @lat: [[tests/project-config#Project Configuration#Project config#Rejects a directory name that would escape or hide the vault]]
  it.each([
    ['invalid JSON', '{', 'invalid JSON'],
    ['a non-object', '[]', 'expected a JSON object'],
    ['a non-string dir', '{"dir": 7}', '"dir" must be a string'],
    ['an empty dir', '{"dir": ""}', '"dir" must not be empty'],
    ['an absolute dir', '{"dir": "/tmp/docs"}', 'must be relative'],
    ['a nested path', '{"dir": "a/b"}', 'single directory name'],
    ['a dot-prefixed dir', '{"dir": ".docs"}', 'must not start with a dot'],
    ['a non-array exclude', '{"dir": "docs", "exclude": "x"}', '"exclude"'],
    [
      'a non-string exclude entry',
      '{"dir": "docs", "exclude": [1]}',
      '"exclude"',
    ],
    [
      'an absolute exclude path',
      '{"dir": "docs", "exclude": ["/etc"]}',
      'must be relative to the vault',
    ],
    [
      'an escaping exclude path',
      '{"dir": "docs", "exclude": ["../secrets"]}',
      'must not contain ".."',
    ],
    [
      'an empty exclude path',
      '{"dir": "docs", "exclude": ["  "]}',
      'must not be empty',
    ],
  ])('reports %s', async (_label, content, message) => {
    const root = await createProject({ 'lat.config.json': content });
    const { config, error } = readLatProjectConfig(root);
    expect(error).toContain(message);
    // Discovery must still be usable so the CLI can report the error itself
    // rather than crashing every command that touches the project.
    expect(config).toEqual({});
    expect(latticeDirName(root)).toBe(DEFAULT_LATTICE_DIR_NAME);
  });

  it('accepts every name the config parser accepts', () => {
    expect(validateLatticeDirName('docs')).toBeNull();
    expect(validateLatticeDirName('handbook')).toBeNull();
    expect(validateLatticeDirName('/abs')).toContain('relative');
    expect(validateLatticeDirName('a/b')).toContain('single directory name');
    expect(validateLatticeDirName('.docs')).toContain('dot');
  });

  it('does not create or remove any file while reading', async () => {
    const root = await createProject(docsVaultFiles('{"dir":"docs"}'));
    const before = await readdir(root, { recursive: true });
    expect(latticeDirName(root)).toBe('docs');
    findLatticeDir(root);
    expect(await readdir(root, { recursive: true })).toEqual(before);
  });
});

describe('vault discovery', () => {
  // @lat: [[tests/project-config#Project Configuration#Vault discovery#Finds a configured vault from a subdirectory]]
  it('finds a configured vault while walking up from a nested directory', async () => {
    const root = await createProject(docsVaultFiles('{"dir":"docs"}'));
    const nested = join(root, 'src', 'deep');
    await mkdir(nested, { recursive: true });
    expect(findLatticeDir(nested)).toBe(join(root, 'docs'));
  });

  it('keeps finding lat.md without a config file', async () => {
    const root = await createProject({
      'lat.md/lat.md': 'Legacy vault index.\n',
    });
    expect(findLatticeDir(root)).toBe(join(root, 'lat.md'));
  });

  it('prefers LAT_DIR over the configured directory', async () => {
    const root = await createProject({
      ...docsVaultFiles('{"dir":"docs"}'),
      'handbook/handbook.md': 'Handbook index.\n',
    });
    process.env.LAT_DIR = 'handbook';
    expect(findLatticeDir(root)).toBe(join(root, 'handbook'));
  });

  // @lat: [[tests/project-config#Project Configuration#Vault discovery#Ignores an unusable LAT_DIR override]]
  it('ignores an unusable LAT_DIR instead of mis-resolving the vault', async () => {
    const root = await createProject(docsVaultFiles('{"dir":"docs"}'));
    // A multi-segment or absolute value would flatten section ids and hide
    // everything outside that subtree, so it is refused rather than honored.
    for (const value of ['a/b/docs', '.', '/abs/docs', '..']) {
      process.env.LAT_DIR = value;
      expect(latDirEnvError()).not.toBeNull();
      expect(findLatticeDir(root)).toBe(join(root, 'docs'));
    }
    process.env.LAT_DIR = 'docs';
    expect(latDirEnvError()).toBeNull();
    expect(findLatticeDir(root)).toBe(join(root, 'docs'));
  });

  it('applies LAT_DIR at every level of the walk', async () => {
    const root = await createProject({
      'handbook/handbook.md': 'Handbook index.\n',
    });
    const nested = join(root, 'src');
    await mkdir(nested, { recursive: true });
    process.env.LAT_DIR = 'handbook';
    expect(findLatticeDir(nested)).toBe(join(root, 'handbook'));
  });

  // @lat: [[tests/project-config#Project Configuration#Vault discovery#Derives section prefixes from the vault path]]
  it('derives section-id prefixes from the vault path', async () => {
    const root = await createProject(docsVaultFiles('{"dir":"docs"}'));
    const latDir = join(root, 'docs');
    expect(latticeDirRel(latDir, root)).toBe('docs');
    expect(latticePathPrefix(latDir, root)).toBe('docs/');
    expect(latticeIndexFileName(latDir)).toBe('docs.md');
    expect(latticeIndexFileName(join(root, 'lat.md'))).toBe('lat.md');
  });
});

describe('embedding endpoint selection', () => {
  // @lat: [[tests/project-config#Project Configuration#Embedding endpoint selection#Prefers the environment over the repo preference]]
  it('prefers the environment over the repo preference', () => {
    process.env.LAT_LLM_BASE_URL = 'https://env.example/v1';
    process.env.LAT_LLM_MODEL = 'env-model';
    // No repo config is read at all when the environment supplies a selection,
    // so a CI job can point at another gateway without editing user config.
    expect(getRemoteSelection('/nonexistent/repo')).toEqual({
      baseUrl: 'https://env.example/v1',
      model: 'env-model',
    });
  });

  it('reports nothing when neither source selects an endpoint', () => {
    expect(getRemoteSelection('/nonexistent/repo')).toEqual({});
  });
});

describe('excluded vault paths', () => {
  /** A vault with one visible file, one excluded directory, and one excluded file. */
  function vaultWithExclusions(): Record<string, string> {
    return {
      'lat.config.json': JSON.stringify({
        dir: 'docs',
        exclude: ['private', 'drafts/scratch.md'],
      }),
      'docs/docs.md':
        'This directory defines the high-level concepts of this project.\n\n- [[architecture]] — System architecture\n- [[drafts]] — Work in progress\n',
      'docs/architecture.md':
        '# Architecture\n\nHow the system is put together.\n',
      // Excluded, and deliberately invalid: a missing leading paragraph and no
      // index entry, so its presence in any result would be visible.
      'docs/private/notes.md': '# Notes\n\n## No leading paragraph\n',
      'docs/drafts/scratch.md': '# Scratch\n\n## Also invalid\n',
      'docs/drafts/kept.md': '# Kept\n\nA kept draft.\n',
      'docs/drafts/drafts.md':
        '# Drafts\n\nWorking notes that are still in progress.\n\n- [[kept]] — A kept draft\n',
    };
  }

  // @lat: [[tests/project-config#Project Configuration#Excluded vault paths#Keeps excluded paths out of the vault walk]]
  it('keeps an excluded directory and file out of the vault walk', async () => {
    const root = await createProject(vaultWithExclusions());
    const files = await listLatticeFiles(join(root, 'docs'));
    expect(files.map((file) => relative(join(root, 'docs'), file))).toEqual([
      'architecture.md',
      'docs.md',
      'drafts/drafts.md',
      'drafts/kept.md',
    ]);
  });

  // @lat: [[tests/project-config#Project Configuration#Excluded vault paths#Validates a vault whose excluded paths are incomplete]]
  it('validates without demanding anything for excluded paths', async () => {
    const root = await createProject(vaultWithExclusions());
    const latDir = join(root, 'docs');
    // `private/notes.md` has no leading paragraph and `drafts/scratch.md` is
    // malformed, so a green check proves both were skipped rather than fixed.
    const { errors } = await checkMd(latDir, root);
    expect(errors).toEqual([]);
    expect(await checkIndex(latDir)).toEqual([]);
  });

  it('leaves everything visible without an exclude list', async () => {
    const root = await createProject({
      ...vaultWithExclusions(),
      'lat.config.json': JSON.stringify({ dir: 'docs' }),
    });
    const files = await listLatticeFiles(join(root, 'docs'));
    expect(files.map((file) => relative(join(root, 'docs'), file))).toEqual([
      'architecture.md',
      'docs.md',
      'drafts/drafts.md',
      'drafts/kept.md',
      'drafts/scratch.md',
      'private/notes.md',
    ]);
  });

  it('composes with a vault .gitignore rule', async () => {
    const root = await createProject({
      ...vaultWithExclusions(),
      'docs/.gitignore': 'drafts/\n',
    });
    const files = await listLatticeFiles(join(root, 'docs'));
    // The config rule drops `private`, the ignore rule drops `drafts`.
    expect(files.map((file) => relative(join(root, 'docs'), file))).toEqual([
      'architecture.md',
      'docs.md',
    ]);
    // Dropping a directory leaves its index entry stale, exactly as deleting
    // the directory would, and the index validator says so.
    expect(
      (await checkIndex(join(root, 'docs'))).map((error) => error.message),
    ).toEqual([
      expect.stringContaining('lists "[[drafts]]" but it does not exist'),
    ]);
  });

  // @lat: [[tests/project-config#Project Configuration#Excluded vault paths#Normalizes equivalent spellings of an excluded path]]
  it('normalizes equivalent spellings of an excluded path', async () => {
    for (const spelling of [
      'private',
      'private/',
      './private',
      ' ./private/ ',
      // Windows separators and redundant separators are accepted by the
      // validator, which splits on both — so they must canonicalize too, or the
      // rule validates and then matches nothing.
      'private\\',
      '.\\private',
      './private//',
    ]) {
      const root = await createProject({
        ...vaultWithExclusions(),
        'lat.config.json': JSON.stringify({
          dir: 'docs',
          exclude: [spelling],
        }),
      });
      // Every consumer has to agree on the canonical form, or the walker and
      // the publication policy disagree about the same config file.
      expect(latticeExcludePaths(join(root, 'docs'))).toEqual(['private']);
      const files = await listLatticeFiles(join(root, 'docs'));
      // Only `private` is excluded here — the fixture's own list is replaced.
      expect(files.map((file) => relative(join(root, 'docs'), file))).toEqual([
        'architecture.md',
        'docs.md',
        'drafts/drafts.md',
        'drafts/kept.md',
        'drafts/scratch.md',
      ]);
    }
  });

  it('matches paths relative to the vault, not the project root', async () => {
    const root = await createProject({
      ...vaultWithExclusions(),
      // `docs/private` would only match if the path were project-relative.
      'lat.config.json': JSON.stringify({
        dir: 'docs',
        exclude: ['docs/private'],
      }),
    });
    const files = await listLatticeFiles(join(root, 'docs'));
    expect(files.map((file) => relative(join(root, 'docs'), file))).toContain(
      'private/notes.md',
    );
  });
});

describe('a configured vault through the analysis path', () => {
  // @lat: [[tests/project-config#Project Configuration#Configured vault#Validates and prefixes ids under the configured name]]
  it('validates links, indexes, and code refs with the configured prefix', async () => {
    const root = await createProject(docsVaultFiles('{"dir":"docs"}'));
    const latDir = join(root, 'docs');

    const sections = await loadAllSections(latDir);
    expect(sections.map((section) => section.id)).toContain(
      'docs/architecture#Architecture',
    );

    const { errors } = await checkMd(latDir, root);
    expect(errors).toEqual([]);

    const { refs } = await scanCodeRefs(root, undefined, {
      latticeDirRel: 'docs',
    });
    expect(refs.map((ref) => ref.target)).toEqual([
      'docs/architecture#Request Pipeline',
    ]);
  });

  it('namespaces every section under the configured prefix', async () => {
    const root = await createProject(docsVaultFiles('{"dir":"docs"}'));
    const latDir = join(root, 'docs');
    const ids = flattenSections(await loadAllSections(latDir)).map(
      (section) => section.id,
    );
    expect(ids).toEqual([
      'docs/architecture#Architecture',
      'docs/architecture#Architecture#Request Pipeline',
    ]);
    // Section ids are project-relative, so none starts at the bare file stem.
    expect(ids.some((id) => id.startsWith('architecture'))).toBe(false);
  });
});
