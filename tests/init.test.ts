import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  readdirSync,
  readlinkSync,
  lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import xdg from '@folder/xdg';
import { parse as parseYaml } from 'yaml';
import { checklistMenu } from '../src/cli/checklist-menu.js';
import {
  INIT_VERSION,
  readInitVersion,
  writeInitMeta,
} from '@lat.md/core/init-version';
import { analyzeMarkdownFile } from '@lat.md/core/markdown-analysis';
import {
  readAgentsTemplate,
  readCursorRulesTemplate,
  readSkillTemplate,
} from '../src/cli/gen.js';

const cliPath = join(
  import.meta.dirname,
  '..',
  'dist',
  'src',
  'cli',
  'index.js',
);
const disableNetworkUrl = pathToFileURL(
  join(import.meta.dirname, 'support', 'disable-network.mjs'),
).href;
const seedDbPath = join(import.meta.dirname, 'support', 'seed-model.mjs');

const {
  closeDb,
  ensureMeta,
  embeddingEnvError,
  getLlmKey,
  getRemoteSelection,
  getRepoEmbedding,
  getStoredModel,
  openDb,
  reindexCommand,
  selectMenu,
  setRepoEmbedding,
} = vi.hoisted(() => ({
  closeDb: vi.fn(async () => {}),
  ensureMeta: vi.fn(async () => {}),
  embeddingEnvError: vi.fn(() => null),
  getLlmKey: vi.fn(),
  getRepoEmbedding: vi.fn(),
  // Resolving the embedder consults the endpoint selection; without it the
  // mocked config module makes init treat a valid key as unusable.
  getRemoteSelection: vi.fn(() => ({})),
  getStoredModel: vi.fn(async () => null as string | null),
  openDb: vi.fn(() => ({})),
  reindexCommand: vi.fn(),
  selectMenu: vi.fn(),
  setRepoEmbedding: vi.fn(),
}));

vi.mock('@lat.md/core/config', () => ({
  embeddingEnvError,
  getLlmKey,
  getRemoteSelection,
  getRepoEmbedding,
  setRepoEmbedding,
}));
vi.mock('../src/version.js', () => ({
  fetchLatestVersion: vi.fn(async () => null),
  getLocalVersion: vi.fn(() => 'test'),
}));
vi.mock('../src/cli/checklist-menu.js', () => ({
  checklistMenu: vi.fn(async () => []),
}));
vi.mock('@lat.md/core/cli/select-menu', () => ({ selectMenu }));
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn(async () => 'n'),
    close: vi.fn(),
  })),
}));
vi.mock('../src/cli/reindex.js', () => ({ reindexCommand }));
vi.mock('../src/search/db.js', () => ({
  closeDb,
  ensureMeta,
  getStoredModel,
  openDb,
}));

import { initCmd } from '../src/cli/init.js';

describe('generated Markdown templates', () => {
  // @lat: [[init#Generated instructions#Templates satisfy graph validation]]
  it('satisfies local graph validation in every Markdown template', () => {
    // Substituted as `lat init` writes them: the placeholder would otherwise
    // leave every section-id example unresolved under the default vault name.
    const templates = [
      ['AGENTS.md', readAgentsTemplate('lat.md')],
      ['cursor-rules.md', readCursorRulesTemplate('lat.md')],
      ['SKILL.md', readSkillTemplate('lat.md')],
    ] as const;

    for (const [name, content] of templates) {
      const analysis = analyzeMarkdownFile(
        `/project/lat.md/${name}`,
        content,
        '/project/lat.md',
        '/project',
      );
      expect(analysis.diagnostics, name).toEqual([]);
    }
  });
});

type CliResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

describe('lat init embedding setup', () => {
  let root: string;
  let stdinIsTTY: PropertyDescriptor | undefined;

  function latDir(): string {
    return join(root, 'lat.md');
  }

  function configPath(): string {
    const env = {
      ...process.env,
      XDG_CONFIG_HOME: join(root, '.config'),
    };
    return join(xdg({ env }).config, 'lat', 'config.json');
  }

  function createLatDir(): void {
    mkdirSync(latDir(), { recursive: true });
  }

  /** Stamp a setup one version behind, so init treats it as outdated. */
  function writeOutdatedInitMeta(): void {
    createLatDir();
    writeInitMeta(latDir(), {});
    const path = join(latDir(), '.cache', 'lat_init.json');
    const meta = JSON.parse(readFileSync(path, 'utf-8')) as {
      init_version: number;
    };
    meta.init_version = INIT_VERSION - 1;
    writeFileSync(path, JSON.stringify(meta, null, 2) + '\n');
  }

  function writeRepoEmbedding(embedding: 'local'): void {
    const path = configPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify(
        { repos: { [resolve(latDir())]: { embedding } } },
        null,
        2,
      ) + '\n',
    );
  }

  function readRepoEmbedding(): 'local' | undefined {
    if (!existsSync(configPath())) return undefined;
    const config = JSON.parse(readFileSync(configPath(), 'utf-8')) as {
      repos?: Record<string, { embedding?: 'local' }>;
    };
    return config.repos?.[resolve(latDir())]?.embedding;
  }

  function seedStoredModel(model: string): void {
    createLatDir();
    const result = spawnSync(process.execPath, [seedDbPath, latDir(), model], {
      encoding: 'utf-8',
    });
    if (result.error) throw result.error;
    expect(result.status, result.stderr).toBe(0);
  }

  function mockStoredModel(model: string): void {
    mkdirSync(join(latDir(), '.cache'), { recursive: true });
    writeFileSync(join(latDir(), '.cache', 'search.db'), 'mock index');
    getStoredModel.mockResolvedValue(model);
  }

  function runInit(key?: string, extra: string[] = []): CliResult {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        disableNetworkUrl,
        cliPath,
        '--no-color',
        'init',
        root,
        ...extra,
      ],
      {
        cwd: root,
        encoding: 'utf-8',
        env: {
          ...process.env,
          XDG_CONFIG_HOME: join(root, '.config'),
          LAT_LLM_KEY: key ?? '',
          LAT_LLM_KEY_FILE: '',
          LAT_LLM_KEY_HELPER: '',
          NO_COLOR: '1',
        },
      },
    );
    if (result.error) throw result.error;
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      exitCode: result.status ?? 1,
    };
  }

  function expectSuccess(result: CliResult): void {
    expect(result.exitCode, result.stderr).toBe(0);
  }

  function setInteractive(interactive: boolean): void {
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: interactive,
    });
  }

  beforeEach(() => {
    // `runInit` spawns the CLI, which reads the endpoint from the environment.
    // A developer with one configured would otherwise resolve a different
    // provider than these tests assume.
    delete process.env.LAT_LLM_BASE_URL;
    delete process.env.LAT_LLM_MODEL;
    root = mkdtempSync(join(tmpdir(), 'lat-init-'));
    stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    setInteractive(false);
    closeDb.mockClear();
    ensureMeta.mockClear();
    getLlmKey.mockReset();
    getRepoEmbedding.mockReset();
    getStoredModel.mockReset();
    getStoredModel.mockResolvedValue(null);
    openDb.mockClear();
    reindexCommand.mockReset();
    reindexCommand.mockResolvedValue({ output: 'Reindexed.' });
    selectMenu.mockReset();
    vi.mocked(checklistMenu).mockReset();
    vi.mocked(checklistMenu).mockResolvedValue([]);
    setRepoEmbedding.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (stdinIsTTY) {
      Object.defineProperty(process.stdin, 'isTTY', stdinIsTTY);
    } else {
      delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
    rmSync(root, { recursive: true, force: true });
  });

  // @lat: [[init#Agent preferences#Remembers completed selections]]
  it('records a custom vault directory and renames the scaffolded index', () => {
    const result = runInit(undefined, ['--vault', 'docs']);
    expectSuccess(result);

    expect(
      JSON.parse(readFileSync(join(root, 'lat.config.json'), 'utf-8')),
    ).toEqual({ dir: 'docs' });
    // The scaffold ships its index as `lat.md`; it must follow the vault name,
    // since an index file has to share its directory's name.
    expect(existsSync(join(root, 'docs', 'docs.md'))).toBe(true);
    expect(existsSync(join(root, 'docs', 'lat.md'))).toBe(false);
  });

  // @lat: [[vault#Init]]
  it('writes no config file for the default vault name', () => {
    expectSuccess(runInit());
    expect(existsSync(join(root, 'lat.md', 'lat.md'))).toBe(true);
    expect(existsSync(join(root, 'lat.config.json'))).toBe(false);
  });

  it('switches a renamed project back to the default vault', () => {
    // Renaming back has to be recorded too, or the config keeps pointing at the
    // old directory and the new vault is unreachable.
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(
      join(root, 'lat.config.json'),
      JSON.stringify({ dir: 'docs' }) + '\n',
    );

    expectSuccess(runInit(undefined, ['--vault', 'lat.md']));

    expect(
      JSON.parse(readFileSync(join(root, 'lat.config.json'), 'utf-8')),
    ).toEqual({ dir: 'lat.md' });
    expect(existsSync(join(root, 'lat.md', 'lat.md'))).toBe(true);
  });

  it('persists selected agents locally and restores them on the next init', async () => {
    createLatDir();
    setInteractive(true);
    const path = join(latDir(), 'config.local.yaml');
    writeFileSync(
      path,
      '# My checkout\nexternal-sources:\n  docs:\n    local-path: ../docs\n',
    );
    vi.mocked(checklistMenu).mockResolvedValueOnce(['codex', 'cursor']);
    selectMenu.mockResolvedValue('global');

    await initCmd(root);

    const saved = readFileSync(path, 'utf8');
    expect(saved).toContain('# My checkout');
    expect(parseYaml(saved)).toEqual({
      'external-sources': { docs: { 'local-path': '../docs' } },
      init: { agents: ['codex', 'cursor'] },
    });
    expect(readFileSync(join(latDir(), '.gitignore'), 'utf8')).toContain(
      'config.local.yaml',
    );
    expect(existsSync(join(root, '.codex', 'config.toml'))).toBe(true);
    expect(existsSync(join(root, '.codex', 'hooks.json'))).toBe(false);

    await initCmd(root);

    expect(checklistMenu).toHaveBeenLastCalledWith(
      expect.any(Array),
      'Which coding agents do you use?',
      ['codex', 'cursor'],
    );
    expect(parseYaml(readFileSync(path, 'utf8')).init.agents).toEqual([]);
  });

  // @lat: [[init#Agent preferences#Non-interactive runs preserve preferences]]
  it('does not create or erase agent preferences without a TTY', async () => {
    createLatDir();
    const path = join(latDir(), 'config.local.yaml');
    await initCmd(root);
    expect(existsSync(path)).toBe(false);
    const original = 'init:\n  agents: [codex]\n';
    writeFileSync(path, original);

    expectSuccess(runInit());

    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(existsSync(join(root, '.codex'))).toBe(false);
  });

  // @lat: [[init#Agent preferences#Aborted setup preserves preferences]]
  it('does not save a selection when the command-style prompt is canceled', async () => {
    createLatDir();
    setInteractive(true);
    const path = join(latDir(), 'config.local.yaml');
    const original = 'init:\n  agents: [cursor]\n';
    writeFileSync(path, original);
    vi.mocked(checklistMenu).mockResolvedValue(['codex']);
    selectMenu.mockResolvedValue(null);

    await initCmd(root);

    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  // @lat: [[init#Agent preferences#Rejects invalid local preferences]]
  it('reports invalid YAML or preference shapes without overwriting them', async () => {
    createLatDir();
    setInteractive(true);
    const path = join(latDir(), 'config.local.yaml');
    for (const original of [
      'init: [',
      '- codex\n',
      'init: false\n',
      'init:\n  agents: codex\n',
    ]) {
      writeFileSync(path, original);
      await expect(initCmd(root)).rejects.toThrow('config.local.yaml');
      expect(readFileSync(path, 'utf8')).toBe(original);
    }
    expect(checklistMenu).not.toHaveBeenCalled();
  });

  // @lat: [[tests/init#Initialization confines every write]]
  it.each([
    'AGENTS.md',
    'CLAUDE.md',
    '.github/copilot-instructions.md',
    '.cursor/rules/lat.md',
    '.mcp.json',
    '.cursor/mcp.json',
    '.vscode/mcp.json',
    '.codex/config.toml',
    '.pi/extensions/lat.ts',
    '.opencode/plugins/lat.ts',
    '.agents/skills/lat-md/SKILL.md',
    'lat.md/config.local.yaml',
    'lat.md/.cache/lat_init.json',
    '.gitignore',
    'lat.md/.gitignore',
  ])('rejects existing and dangling external symlinks at %s', async (path) => {
    createLatDir();
    setInteractive(true);
    vi.mocked(checklistMenu).mockResolvedValue([
      'claude',
      'codex',
      'cursor',
      'copilot',
      'pi',
      'opencode',
    ]);
    selectMenu.mockResolvedValue('global');
    const outside = mkdtempSync(join(tmpdir(), 'lat-init-victim-'));
    const victim = join(outside, 'victim');
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    try {
      for (const existing of [true, false]) {
        if (existing) writeFileSync(victim, 'unchanged');
        else rmSync(victim, { force: true });
        rmSync(destination, { force: true });
        symlinkSync(victim, destination);
        await expect(initCmd(root)).rejects.toThrow(join(...path.split('/')));
        if (existing) expect(readFileSync(victim, 'utf8')).toBe('unchanged');
        else expect(existsSync(victim)).toBe(false);
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it.each([
    'lat.md',
    'lat.md/.cache',
    '.claude',
    '.codex',
    '.cursor',
    '.vscode',
    '.pi',
    '.opencode',
    '.github',
    '.agents',
  ])('rejects external directory symlinks at %s', async (path) => {
    createLatDir();
    setInteractive(true);
    vi.mocked(checklistMenu).mockResolvedValue([
      'claude',
      'codex',
      'cursor',
      'copilot',
      'pi',
      'opencode',
    ]);
    selectMenu.mockResolvedValue('global');
    const outside = mkdtempSync(join(tmpdir(), 'lat-init-victim-'));
    const destination = join(root, path);
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(dirname(destination), { recursive: true });
    symlinkSync(
      outside,
      destination,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    try {
      await expect(initCmd(root)).rejects.toThrow(join(...path.split('/')));
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('preserves in-project instruction symlinks and unrelated user text', async () => {
    createLatDir();
    setInteractive(true);
    vi.mocked(checklistMenu).mockResolvedValue(['codex']);
    selectMenu.mockResolvedValue('global');
    const target = join(root, 'instructions.md');
    writeFileSync(target, '# My instructions\n\nKeep this text.\n');
    symlinkSync(target, join(root, 'AGENTS.md'));
    await initCmd(root);
    expect(lstatSync(join(root, 'AGENTS.md')).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toContain('Keep this text.');
    expect(readFileSync(target, 'utf8')).toContain('%% lat:begin %%');
  });

  // @lat: [[tests/init#Claude Code reads AGENTS.md#Links CLAUDE.md instead of duplicating the section]]
  it('links CLAUDE.md to AGENTS.md rather than writing a second copy', async () => {
    createLatDir();
    setInteractive(true);
    vi.mocked(checklistMenu).mockResolvedValue(['claude']);
    selectMenu.mockResolvedValue('global');

    await initCmd(root);

    const claude = join(root, 'CLAUDE.md');
    expect(lstatSync(claude).isSymbolicLink()).toBe(true);
    expect(readlinkSync(claude)).toBe('AGENTS.md');
    // Claude Code is not a special case: AGENTS.md is written even when it is
    // the only agent selected, because that is the file the link resolves to.
    const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('%% lat:begin %%');
    expect(readFileSync(claude, 'utf8')).toBe(agents);

    // Re-running must not append a second section through the link.
    await initCmd(root);
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(agents);
  });

  // @lat: [[tests/init#Claude Code reads AGENTS.md#Installs no hooks for any agent]]
  it('installs no hooks for any selected agent', async () => {
    createLatDir();
    setInteractive(true);
    vi.mocked(checklistMenu).mockResolvedValue(['claude', 'pi', 'codex']);
    selectMenu.mockResolvedValue('global');

    await initCmd(root);

    expect(readlinkSync(join(root, 'CLAUDE.md'))).toBe('AGENTS.md');
    for (const path of [
      '.claude/settings.json',
      '.codex/hooks.json',
      '.cursor/hooks.json',
    ])
      expect(existsSync(join(root, path)), path).toBe(false);
    // The Pi extension registers tools only; prompt guidance comes from
    // AGENTS.md rather than an injected reminder. Renderers are included in
    // the check because they exist only to display what a hook emits.
    const pi = readFileSync(join(root, '.pi/extensions/lat.ts'), 'utf8');
    expect(pi).not.toContain('pi.on(');
    expect(pi).not.toContain('registerMessageRenderer');
    expect(pi).toContain('pi.registerTool');
    // Dropping hooks must not drop tool access.
    expect(readFileSync(join(root, '.mcp.json'), 'utf8')).toContain('"lat"');
    expect(readFileSync(join(root, '.codex/config.toml'), 'utf8')).toContain(
      'lat',
    );
  });

  // @lat: [[tests/init#Claude Code reads AGENTS.md#Removes hooks an earlier init installed]]
  it('removes hooks an earlier init installed and keeps the user own', async () => {
    createLatDir();
    setInteractive(true);
    vi.mocked(checklistMenu).mockResolvedValue([]);
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'custom prompt hook' }] },
            {
              hooks: [
                {
                  type: 'command',
                  command: 'lat hook claude UserPromptSubmit',
                },
              ],
            },
          ],
        },
      }),
    );
    mkdirSync(join(root, '.codex'), { recursive: true });
    writeFileSync(
      join(root, '.codex', 'hooks.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: 'lat hook codex Stop' }] },
          ],
        },
      }),
    );

    await initCmd(root);

    // Cleanup runs whatever the agent selection is, so "no agents" still
    // migrates a project set up before hooks were dropped.
    const settings = JSON.parse(
      readFileSync(join(root, '.claude', 'settings.json'), 'utf8'),
    );
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toBe(
      'custom prompt hook',
    );
    // This one held nothing but lat hooks, so it is gone entirely.
    expect(existsSync(join(root, '.codex', 'hooks.json'))).toBe(false);
  });

  // @lat: [[tests/init#Claude Code reads AGENTS.md#Keeps a hand-written CLAUDE.md]]
  it('leaves a CLAUDE.md carrying the user own instructions alone', async () => {
    createLatDir();
    setInteractive(true);
    vi.mocked(checklistMenu).mockResolvedValue(['claude']);
    selectMenu.mockResolvedValue('global');
    const claude = join(root, 'CLAUDE.md');
    const original = '# House rules\n\nAlways write tests first.\n';
    writeFileSync(claude, original);

    await initCmd(root);

    expect(lstatSync(claude).isSymbolicLink()).toBe(false);
    expect(readFileSync(claude, 'utf8')).toBe(original);
  });

  // @lat: [[tests/init#Claude Code reads AGENTS.md#Replaces a lat-only CLAUDE.md]]
  it('replaces a CLAUDE.md holding nothing but the generated section', async () => {
    createLatDir();
    setInteractive(true);
    vi.mocked(checklistMenu).mockResolvedValue(['claude']);
    selectMenu.mockResolvedValue('global');
    const claude = join(root, 'CLAUDE.md');
    writeFileSync(
      claude,
      '%% lat:begin %%\n# Generated by an older init\n%% lat:end %%\n',
    );

    await initCmd(root);

    expect(lstatSync(claude).isSymbolicLink()).toBe(true);
    expect(readlinkSync(claude)).toBe('AGENTS.md');
  });

  // @lat: [[init#Embedding setup#Fresh init pins local embeddings]]
  it('pins local embeddings before agent selection on a fresh init', () => {
    const result = runInit('sk-test');

    expectSuccess(result);
    expect(readRepoEmbedding()).toBe('local');
    expect(readInitVersion(latDir())).toBe(INIT_VERSION);
  });

  // @lat: [[tests/init#Lat-owned build output ignore]]
  it('gitignores the Lat-owned UI build output', async () => {
    const git = spawnSync('git', ['init', '--quiet'], { cwd: root });
    expect(git.status, git.stderr?.toString()).toBe(0);

    await initCmd(root);

    const ignored = readFileSync(join(root, '.gitignore'), 'utf8').split(
      /\r?\n/,
    );
    expect(ignored).toContain('.lat-build');
    expect(ignored).not.toContain('.vercel');
  });

  // @lat: [[init#Embedding setup#Configured key asks for a backend]]
  it('allows a configured key to opt the repo into hosted embeddings', async () => {
    createLatDir();
    getLlmKey.mockReturnValue('sk-test');
    selectMenu.mockResolvedValue('remote');
    setInteractive(true);

    await initCmd(root);

    expect(selectMenu).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ value: 'local' }),
        expect.objectContaining({ value: 'remote' }),
      ]),
      'Embedding backend',
      0,
    );
    expect(setRepoEmbedding).toHaveBeenCalledWith(latDir(), null);
  });

  // @lat: [[init#Embedding setup#Backend mismatch offers reindexing]]
  it('offers and runs a local reindex for an existing remote index', async () => {
    createLatDir();
    mockStoredModel('openai:1536');
    selectMenu.mockResolvedValue('now');
    setInteractive(true);

    await initCmd(root);

    expect(selectMenu).toHaveBeenCalledWith(
      expect.any(Array),
      'Rebuild the existing index with local embeddings?',
      0,
    );
    expect(reindexCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        latDir: latDir(),
        projectRoot: root,
        mode: 'cli',
      }),
      { local: true },
    );
  });

  // @lat: [[init#Embedding setup#Current setup preserves explicit backend choice]]
  it('does not overwrite the backend choice on a current re-run', () => {
    createLatDir();
    writeInitMeta(latDir(), {});
    writeRepoEmbedding('local');

    const result = runInit();

    expectSuccess(result);
    expect(readRepoEmbedding()).toBe('local');
  });

  // @lat: [[init#Embedding setup#Hosted re-run defaults to hosted]]
  // @lat: [[rag-architecture#Custom endpoints]]
  it('leaves a hosted repo alone when its endpoint cannot be reached', async () => {
    setInteractive(false);
    writeOutdatedInitMeta();
    mockStoredModel('custom:old-embed:4');
    getLlmKey.mockReturnValue('sk-test');
    // The configured model differs from the recorded one, so the width cannot
    // be reused and the endpoint really is contacted — and refuses. That
    // stands in for a transient outage: it says nothing about whether the
    // configured endpoint works.
    getRemoteSelection.mockReturnValue({
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'tiny-embed',
    });

    await initCmd(root);

    // Pinning local here would silently discard a working gateway.
    expect(setRepoEmbedding).not.toHaveBeenCalled();
    expect(readRepoEmbedding()).toBeUndefined();
  });

  // @lat: [[rag-architecture#Custom endpoints]]
  it('recognizes a reachable endpoint without contacting it when the width is known', async () => {
    setInteractive(false);
    writeOutdatedInitMeta();
    mockStoredModel('custom:tiny-embed:4');
    getLlmKey.mockReturnValue('sk-test');
    // Same model as the index recorded, so its width is reused and no request
    // is made — the resolution must still recognize the working setup.
    getRemoteSelection.mockReturnValue({
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'tiny-embed',
    });

    await initCmd(root);

    expect(setRepoEmbedding).not.toHaveBeenCalled();
    expect(reindexCommand).not.toHaveBeenCalled();
  });

  it('still pins local when the key itself is unusable', async () => {
    setInteractive(false);
    writeOutdatedInitMeta();
    mockStoredModel('openai:1536');
    getLlmKey.mockReturnValue('sk-ant-not-an-embedding-provider');

    await initCmd(root);

    expect(setRepoEmbedding).toHaveBeenCalledWith(latDir(), 'local');
  });

  it('defaults an interactive hosted re-run to its existing backend', async () => {
    createLatDir();
    writeInitMeta(latDir(), {});
    mockStoredModel('openai:1536');
    getLlmKey.mockReturnValue('sk-test');
    selectMenu.mockResolvedValue('remote');
    setInteractive(true);

    await initCmd(root);

    expect(selectMenu).toHaveBeenCalledWith(
      expect.any(Array),
      'Embedding backend',
      1,
    );
    expect(setRepoEmbedding).toHaveBeenCalledWith(latDir(), null);
    expect(reindexCommand).not.toHaveBeenCalled();
  });

  // @lat: [[init#Embedding setup#Non-interactive re-run does not choose]]
  it('does not prompt or mutate a current hosted repo without a TTY', () => {
    createLatDir();
    writeInitMeta(latDir(), {});
    seedStoredModel('openai:1536');

    const result = runInit('sk-test');

    expectSuccess(result);
    expect(result.stdout).not.toContain('Embedding backend');
    expect(readRepoEmbedding()).toBeUndefined();
  });

  // @lat: [[init#Embedding setup#Outdated re-run keeps a working hosted index]]
  it('leaves an outdated hosted repo on its existing backend', () => {
    writeOutdatedInitMeta();
    seedStoredModel('openai:1536');

    const result = runInit('sk-test');

    expectSuccess(result);
    expect(readRepoEmbedding()).toBeUndefined();
    expect(result.stdout).not.toContain('lat reindex --local');
  });

  // @lat: [[init#Embedding setup#Outdated hosted provider mismatch defaults local]]
  it('defaults an outdated hosted repo to local when its key provider changed', () => {
    writeOutdatedInitMeta();
    seedStoredModel('openai:1536');

    const result = runInit('vck_test');

    expectSuccess(result);
    expect(readRepoEmbedding()).toBe('local');
    expect(result.stdout).toContain('lat reindex --local');
  });

  // @lat: [[init#Embedding setup#Hosted provider mismatch offers reindexing]]
  it('prints a remote reindex command when the hosted provider changed', () => {
    createLatDir();
    writeInitMeta(latDir(), {});
    seedStoredModel('openai:1536');

    const result = runInit('vck_test');

    expectSuccess(result);
    expect(result.stdout).toContain('lat reindex --remote');
    expect(readRepoEmbedding()).toBeUndefined();
  });

  // @lat: [[init#Embedding setup#Non-interactive mismatch prints command]]
  it('prints the reindex command for a non-interactive mismatch', () => {
    createLatDir();
    writeInitMeta(latDir(), {});
    seedStoredModel('openai:1536');
    writeRepoEmbedding('local');

    const result = runInit();

    expectSuccess(result);
    expect(result.stdout).toContain('lat reindex --local');
    expect(readRepoEmbedding()).toBe('local');
  });
});
