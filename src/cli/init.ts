import { agentInvocation } from './agent-invocation.js';
import { projectWritePath, writeProjectFile } from '@lat.md/core/project-write';
import {
  existsSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { styleText } from 'node:util';
import { findTemplatesDir } from './templates.js';
import {
  readAgentsTemplate,
  readCursorRulesTemplate,
  readPiExtensionTemplate,
  readOpenCodePluginTemplate,
  readSkillTemplate,
} from './gen.js';
import {
  getLlmKey,
  getRemoteSelection,
  getRepoEmbedding,
  setRepoEmbedding,
} from '@lat.md/core/config';
import { detectProvider } from '@lat.md/embed';
import { makeStyler } from '@lat.md/core/cli/context';
import { closeDb, getStoredModel, openDb } from '../search/db.js';
import { embedderFromEnv, modelKey } from '../search/embedder.js';
import { reindexCommand } from './reindex.js';
import {
  INIT_VERSION,
  writeInitMeta,
  readInitVersion,
  readFileHash,
  contentHash,
} from '@lat.md/core/init-version';
import { getLocalVersion, fetchLatestVersion } from '../version.js';
import {
  DEFAULT_LATTICE_DIR_NAME,
  LAT_CONFIG_FILE,
  latticeIndexFileName,
  projectConfigError,
  readLatProjectConfig,
  validateLatticeDirName,
} from '@lat.md/core/project-discovery';
import { selectMenu, type SelectOption } from '@lat.md/core/cli/select-menu';
import { checklistMenu } from './checklist-menu.js';
import { readInitAgents, writeInitAgents } from './init-preferences.js';

async function confirm(
  rl: ReturnType<typeof createInterface>,
  message: string,
): Promise<boolean> {
  while (true) {
    let answer: string;
    try {
      answer = await rl.question(`${message} ${styleText('dim', '[Y/n]')} `);
    } catch {
      // Ctrl+C or closed stdin — abort
      console.log('');
      process.exit(130);
    }
    const val = answer.trim().toLowerCase();
    if (val === '' || val === 'y' || val === 'yes') return true;
    if (val === 'n' || val === 'no') return false;
    console.log(styleText('yellow', '  Please answer Y or n.'));
  }
}

// ── Binary resolution ────────────────────────────────────────────────

/**
 * Return the loader-related flags from `process.execArgv`, stripping
 * `--eval`/`-e`/`--print`/`-p` and their value arguments (those only
 * appear when the process was started with `node -e`/`-p`).
 */
function loaderExecArgs(): string[] {
  const raw = process.execArgv;
  const args: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (
      raw[i] === '--eval' ||
      raw[i] === '-e' ||
      raw[i] === '--print' ||
      raw[i] === '-p'
    ) {
      i++; // skip the value argument
    } else {
      args.push(raw[i]);
    }
  }
  return args;
}

/**
 * Reconstruct the executable and arguments used to invoke this process.
 *
 * Node script entry points must keep their Node launcher. Build output from
 * `tsc` is not executable by default, even when it retains a shebang.
 *
 * When running via a TypeScript loader like tsx, the script itself can't be
 * executed directly — we need to replay the same node flags that loaded tsx.
 * Wrapper scripts and standalone binaries are already executable and can be
 * invoked directly.
 */
function resolveLatInvocation(): { command: string; args: string[] } {
  const script = resolve(process.argv[1]);
  const isTypeScript = /\.[cm]?ts$/.test(script);
  const isJavaScript = /\.[cm]?js$/.test(script);
  if (!isTypeScript && !isJavaScript) {
    return { command: script, args: [] };
  }

  return {
    command: process.execPath,
    args: [...(isTypeScript ? loaderExecArgs() : []), script],
  };
}

/** Format the current invocation for command-string based integrations. */
function resolveLatBin(): string {
  const { command, args } = resolveLatInvocation();
  return [command, ...args]
    .map((arg) => (arg.includes(' ') ? `"${arg}"` : arg))
    .join(' ');
}

// ── Command style ───────────────────────────────────────────────────

/**
 * How generated agent configuration invokes lat. `npx lat.md@latest` is
 * deliberately not offered: it resolves the published upstream package, which
 * would silently swap this build for one without its configuration support.
 */
type LatCommandStyle = 'global' | 'local';

/** Return the MCP server command descriptor for the given command style. */
function styledMcpCommand(style: LatCommandStyle): {
  command: string;
  args: string[];
} {
  return style === 'global' ? { command: 'lat', args: ['mcp'] } : mcpCommand();
}

// ── Gitignore helper ─────────────────────────────────────────────────

function ensureGitignored(root: string, entry: string): void {
  const gitignorePath = projectWritePath(root, join(root, '.gitignore'));
  const gitDir = join(root, '.git');

  // Check if already ignored
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, 'utf-8');
    const lines = content.split('\n').map((l) => l.trim());
    if (lines.includes(entry)) {
      console.log(styleText('green', `  ${entry}`) + ' already in .gitignore');
      return;
    }
  }

  // Skip if the entry is already tracked in git — adding it to .gitignore
  // would have no effect and confuse the user.
  if (existsSync(gitDir)) {
    try {
      const result = execSync(`git ls-files "${entry}"`, {
        cwd: root,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (result.trim().length > 0) {
        console.log(
          styleText('yellow', `  ${entry}`) +
            ' is already checked in to git — skipping .gitignore',
        );
        return;
      }
    } catch {
      console.log(
        styleText('yellow', `  Warning:`) +
          ' git ls-files failed — skipping check',
      );
    }
  }

  if (existsSync(gitignorePath)) {
    // Append to existing .gitignore
    let content = readFileSync(gitignorePath, 'utf-8');
    if (!content.endsWith('\n')) content += '\n';
    writeProjectFile(root, gitignorePath, content + entry + '\n');
    console.log(styleText('green', `  Added ${entry}`) + ' to .gitignore');
  } else if (existsSync(gitDir)) {
    // Create .gitignore with the entry
    writeProjectFile(root, gitignorePath, entry + '\n');
    console.log(styleText('green', `  Created .gitignore`) + ` with ${entry}`);
  } else {
    console.log(
      styleText('yellow', `  Warning:`) +
        ` could not add ${entry} to .gitignore (not a git repository)`,
    );
  }
}

// ── MCP command detection ────────────────────────────────────────────

/**
 * Derive the MCP server command from the currently running binary.
 * If `lat init` was invoked as `/path/to/lat`, we emit
 * `{ command: "/path/to/lat", args: ["mcp"] }` so the MCP client
 * starts the same binary. Node scripts retain their Node executable; TypeScript
 * scripts also retain loader arguments such as tsx's `--import` flag.
 */
function mcpCommand(): { command: string; args: string[] } {
  const { command, args } = resolveLatInvocation();

  return {
    command,
    args: [...args, 'mcp'],
  };
}

// ── MCP config helpers ───────────────────────────────────────────────

type McpConfig = Record<
  string,
  Record<string, { command: string; args: string[] }>
>;

function hasMcpServer(root: string, configPath: string, key: string): boolean {
  projectWritePath(root, configPath);
  if (!existsSync(configPath)) return false;
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    return !!cfg?.[key]?.lat;
  } catch (err) {
    process.stderr.write(
      `Warning: failed to parse ${configPath}: ${(err as Error).message}\n`,
    );
    return false;
  }
}

function addMcpServer(
  root: string,
  configPath: string,
  key: string,
  style: LatCommandStyle,
): void {
  projectWritePath(root, configPath);
  let cfg: McpConfig = { [key]: {} };
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, 'utf-8');
    try {
      cfg = JSON.parse(raw);
      if (!cfg[key]) cfg[key] = {};
    } catch (e) {
      throw new Error(`Cannot parse ${configPath}: ${(e as Error).message}`);
    }
  }

  cfg[key].lat = styledMcpCommand(style);

  mkdirSync(join(configPath, '..'), { recursive: true });
  writeProjectFile(root, configPath, JSON.stringify(cfg, null, 2) + '\n');
}

// ── Codex TOML MCP helpers ────────────────────────────────────────────

/**
 * Check whether `.codex/config.toml` already contains an `[mcp_servers.lat]`
 * table.  We use a simple regex match — no TOML parser needed.
 */
function hasCodexMcpServer(root: string, configPath: string): boolean {
  projectWritePath(root, configPath);
  if (!existsSync(configPath)) return false;
  try {
    const content = readFileSync(configPath, 'utf-8');
    return /^\[mcp_servers\.lat\]/m.test(content);
  } catch {
    return false;
  }
}

/**
 * Append an `[mcp_servers.lat]` table to `.codex/config.toml`.
 *
 * If the file exists, the block is appended (preserving existing content).
 * If the file doesn't exist, it is created with just the MCP block.
 *
 * The TOML format is intentionally simple — Codex expects:
 *
 * ```toml
 * [mcp_servers.lat]
 * command = "lat"
 * args = ["mcp"]
 * ```
 */
function addCodexMcpServer(
  root: string,
  configPath: string,
  style: LatCommandStyle,
): void {
  projectWritePath(root, configPath);
  const cmd = styledMcpCommand(style);

  // Format args as a TOML inline array of quoted strings
  const argsToml = '[' + cmd.args.map((a) => `"${a}"`).join(', ') + ']';
  const block = `[mcp_servers.lat]\ncommand = "${cmd.command}"\nargs = ${argsToml}\n`;

  mkdirSync(join(configPath, '..'), { recursive: true });

  if (existsSync(configPath)) {
    let content = readFileSync(configPath, 'utf-8');
    if (!content.endsWith('\n')) content += '\n';
    content += '\n' + block;
    writeProjectFile(root, configPath, content);
  } else {
    writeProjectFile(root, configPath, block);
  }
}

// ── Template file helpers ─────────────────────────────────────────────

/**
 * Write a template-generated file, using stored hashes to decide whether
 * to overwrite or prompt the user about local modifications.
 *
 * Returns the hash of the written content, or null if the file was skipped.
 */
async function writeTemplateFile(
  root: string,
  latDir: string,
  relPath: string,
  template: string,
  genTarget: string | null,
  label: string,
  indent: string,
  ask: (message: string) => Promise<boolean>,
): Promise<string | null> {
  const absPath = projectWritePath(root, join(root, relPath));
  const templateHash = contentHash(template);

  if (!existsSync(absPath)) {
    mkdirSync(join(absPath, '..'), { recursive: true });
    writeProjectFile(root, absPath, template);
    console.log(styleText('green', `${indent}Created ${label}`));
    return templateHash;
  }

  // File exists — check if user has modified it
  const currentContent = readFileSync(absPath, 'utf-8');
  const currentHash = contentHash(currentContent);
  const storedHash = readFileHash(latDir, relPath);

  if (currentHash === templateHash) {
    // Already matches the latest template
    console.log(
      styleText('green', `${indent}${label}`) + ' already up to date',
    );
    return templateHash;
  }

  if (storedHash && currentHash === storedHash) {
    // Unmodified by user — safe to overwrite with new template
    writeProjectFile(root, absPath, template);
    console.log(styleText('green', `${indent}Updated ${label}`));
    return templateHash;
  }

  // User has modified the file — ask whether to overwrite
  console.log(
    styleText('yellow', `${indent}${label}`) +
      ' exists and may contain your own content.',
  );
  if (await ask(`${indent}Overwrite with latest lat template?`)) {
    writeProjectFile(root, absPath, template);
    console.log(styleText('green', `${indent}Updated ${label}`));
    return templateHash;
  }

  console.log(
    genTarget
      ? styleText('dim', `${indent}Kept existing file.`) +
          ' Run ' +
          styleText('cyan', `lat gen ${genTarget}`) +
          ' to see the latest template.'
      : styleText('dim', `${indent}Kept existing file.`) +
          ' Re-run ' +
          styleText('cyan', 'lat init') +
          ' to regenerate this file.',
  );
  return null;
}

// ── Marker-based append for shared files ─────────────────────────────

const MARKER_BEGIN = '%% lat:begin %%';
const MARKER_END = '%% lat:end %%';

/**
 * Extract the content between lat markers in a file's text.
 * Returns null if markers are not found.
 */
function extractMarkerSection(content: string): string | null {
  const beginIdx = content.indexOf(MARKER_BEGIN);
  const endIdx = content.indexOf(MARKER_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) return null;
  return content.slice(beginIdx + MARKER_BEGIN.length + 1, endIdx);
}

/**
 * Wrap template content with lat markers.
 */
function wrapWithMarkers(template: string): string {
  return `${MARKER_BEGIN}\n${template}${template.endsWith('\n') ? '' : '\n'}${MARKER_END}\n`;
}

/** Everything in a file except the generated marker section. */
function withoutMarkerSection(content: string): string {
  const beginIdx = content.indexOf(MARKER_BEGIN);
  const endIdx = content.indexOf(MARKER_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) return content;
  return content.slice(0, beginIdx) + content.slice(endIdx + MARKER_END.length);
}

/**
 * Point CLAUDE.md at AGENTS.md instead of writing the generated section twice.
 * Two files holding the same instructions drift as soon as one is edited, and
 * `projectWritePath` resolves an in-project symlink, so a later `lat init`
 * writing `CLAUDE.md` lands in `AGENTS.md` and stays idempotent.
 *
 * A `CLAUDE.md` carrying the user's own prose is left untouched: silently
 * discarding hand-written instructions is worse than a duplicate.
 */
function linkClaudeInstructions(root: string): void {
  const linkPath = join(root, 'CLAUDE.md');
  const label = styleText('green', '  CLAUDE.md');
  // Same guard every other managed path goes through: a symlink escaping the
  // project, or a dangling one, is refused rather than written through.
  projectWritePath(root, linkPath);
  let info: Stats | undefined;
  try {
    info = lstatSync(linkPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  if (info?.isSymbolicLink()) {
    const target = readlinkSync(linkPath);
    console.log(
      target === 'AGENTS.md'
        ? `${label} already links to AGENTS.md`
        : styleText('yellow', '  CLAUDE.md') +
            ` links to ${target}, not AGENTS.md — leaving it alone`,
    );
    return;
  }

  if (info) {
    if (withoutMarkerSection(readFileSync(linkPath, 'utf-8')).trim()) {
      console.log(
        styleText('yellow', '  CLAUDE.md') +
          ' has your own content — move it into AGENTS.md and replace CLAUDE.md with a symlink',
      );
      return;
    }
    rmSync(linkPath);
  }

  symlinkSync('AGENTS.md', linkPath);
  console.log(`${label} → AGENTS.md`);
}

/**
 * Write a template into a marker-fenced section of a file, preserving
 * any user content outside the markers.
 *
 * Returns the hash of the written template content, or null if skipped.
 */
async function appendTemplateSection(
  root: string,
  latDir: string,
  relPath: string,
  template: string,
  label: string,
  indent: string,
  ask: (message: string) => Promise<boolean>,
): Promise<string | null> {
  const absPath = projectWritePath(root, join(root, relPath));
  const templateHash = contentHash(template);
  const wrapped = wrapWithMarkers(template);

  if (!existsSync(absPath)) {
    mkdirSync(join(absPath, '..'), { recursive: true });
    writeProjectFile(root, absPath, wrapped);
    console.log(styleText('green', `${indent}Created ${label}`));
    return templateHash;
  }

  const currentContent = readFileSync(absPath, 'utf-8');
  const existingSection = extractMarkerSection(currentContent);

  if (existingSection !== null) {
    // File has markers — compare the section content
    const existingSectionHash = contentHash(existingSection);

    if (existingSectionHash === templateHash) {
      console.log(
        styleText('green', `${indent}${label}`) + ' already up to date',
      );
      return templateHash;
    }

    // Check if section matches stored hash (unmodified by user)
    const storedHash = readFileHash(latDir, relPath);
    if (storedHash && existingSectionHash === storedHash) {
      // User hasn't edited the section — safe to replace
      const beginIdx = currentContent.indexOf(MARKER_BEGIN);
      const endIdx = currentContent.indexOf(MARKER_END) + MARKER_END.length;
      // Include trailing newline if present
      const endWithNl = currentContent[endIdx] === '\n' ? endIdx + 1 : endIdx;
      const updated =
        currentContent.slice(0, beginIdx) +
        wrapped +
        currentContent.slice(endWithNl);
      writeProjectFile(root, absPath, updated);
      console.log(styleText('green', `${indent}Updated ${label}`));
      return templateHash;
    }

    // User edited the section — ask before replacing
    console.log(
      styleText('yellow', `${indent}${label}`) +
        ' lat section has been modified.',
    );
    if (await ask(`${indent}Replace lat section with latest template?`)) {
      const beginIdx = currentContent.indexOf(MARKER_BEGIN);
      const endIdx = currentContent.indexOf(MARKER_END) + MARKER_END.length;
      const endWithNl = currentContent[endIdx] === '\n' ? endIdx + 1 : endIdx;
      const updated =
        currentContent.slice(0, beginIdx) +
        wrapped +
        currentContent.slice(endWithNl);
      writeProjectFile(root, absPath, updated);
      console.log(styleText('green', `${indent}Updated ${label}`));
      return templateHash;
    }

    console.log(styleText('dim', `${indent}Kept existing section.`));
    return null;
  }

  // No markers — file exists from old init or user-created
  // Check if full file matches stored hash (old full-overwrite init, unedited)
  const currentHash = contentHash(currentContent);
  const storedHash = readFileHash(latDir, relPath);

  if (storedHash && currentHash === storedHash) {
    // Unmodified old-style file — migrate: wrap existing content with markers
    writeProjectFile(root, absPath, wrapWithMarkers(currentContent));
    console.log(
      styleText('green', `${indent}Migrated ${label}`) + ' to marker format',
    );
    // Return hash of what's now in the section (the old content)
    return currentHash;
  }

  // File has user content and no markers — append section
  let content = currentContent;
  if (!content.endsWith('\n')) content += '\n';
  content += '\n' + wrapped;
  writeProjectFile(root, absPath, content);
  console.log(styleText('green', `${indent}Appended lat section to ${label}`));
  return templateHash;
}

// ── Shared skill setup ───────────────────────────────────────────────

async function writeAgentsSkill(
  root: string,
  latDir: string,
  hashes: Record<string, string>,
  ask: (message: string) => Promise<boolean>,
): Promise<void> {
  console.log('');
  console.log(
    styleText(
      'dim',
      `  The lat-md skill teaches the agent how to write and maintain ${basename(latDir)}/ files.`,
    ),
  );

  const skillTemplate = readSkillTemplate(basename(latDir));
  const skillHash = await writeTemplateFile(
    root,
    latDir,
    '.agents/skills/lat-md/SKILL.md',
    skillTemplate,
    'skill.md',
    'Skill (.agents/skills/lat-md/SKILL.md)',
    '  ',
    ask,
  );
  if (skillHash) hashes['.agents/skills/lat-md/SKILL.md'] = skillHash;
}

// ── Per-agent setup ──────────────────────────────────────────────────

async function setupAgentsMd(
  root: string,
  latDir: string,
  template: string,
  hashes: Record<string, string>,
  ask: (message: string) => Promise<boolean>,
): Promise<void> {
  const hash = await appendTemplateSection(
    root,
    latDir,
    'AGENTS.md',
    template,
    'AGENTS.md',
    '',
    ask,
  );
  if (hash) hashes['AGENTS.md'] = hash;
}

async function setupClaudeCode(
  root: string,
  latDir: string,
  hashes: Record<string, string>,
  ask: (message: string) => Promise<boolean>,
  style: LatCommandStyle,
): Promise<void> {
  linkClaudeInstructions(root);

  // .claude/skills/lat-md/SKILL.md — skill for authoring lat.md files
  console.log('');
  console.log(
    styleText(
      'dim',
      `  The lat-md skill teaches the agent how to write and maintain ${basename(latDir)}/ files.`,
    ),
  );

  const skillTemplate = readSkillTemplate(basename(latDir));
  const skillHash = await writeTemplateFile(
    root,
    latDir,
    '.claude/skills/lat-md/SKILL.md',
    skillTemplate,
    'skill.md',
    'Skill (.claude/skills/lat-md/SKILL.md)',
    '  ',
    ask,
  );
  if (skillHash) hashes['.claude/skills/lat-md/SKILL.md'] = skillHash;

  // Ensure .claude is gitignored (settings contain local absolute paths)
  ensureGitignored(root, '.claude');

  // MCP server → .mcp.json at project root
  console.log('');
  console.log(
    styleText(
      'dim',
      '  Agents can call `lat` from the command line, but an MCP server gives lat',
    ),
  );
  console.log(
    styleText(
      'dim',
      '  more visibility and makes agents more likely to use it proactively.',
    ),
  );

  const mcpPath = join(root, '.mcp.json');
  if (hasMcpServer(root, mcpPath, 'mcpServers')) {
    console.log(styleText('green', '  MCP server') + ' already configured');
  } else {
    addMcpServer(root, mcpPath, 'mcpServers', style);
    console.log(
      styleText('green', '  MCP server') + ' registered in .mcp.json',
    );
  }

  // Ensure .mcp.json is gitignored (it contains local absolute paths)
  ensureGitignored(root, '.mcp.json');
}

async function setupCursor(
  root: string,
  latDir: string,
  hashes: Record<string, string>,
  ask: (message: string) => Promise<boolean>,
  style: LatCommandStyle,
): Promise<void> {
  // .cursor/rules/lat.md
  const hash = await writeTemplateFile(
    root,
    latDir,
    '.cursor/rules/lat.md',
    readCursorRulesTemplate(basename(latDir)),
    'cursor-rules.md',
    'Rules (.cursor/rules/lat.md)',
    '  ',
    ask,
  );
  if (hash) hashes['.cursor/rules/lat.md'] = hash;

  // .cursor/mcp.json
  console.log('');
  console.log(
    styleText(
      'dim',
      '  Agents can call `lat` from the command line, but an MCP server gives lat',
    ),
  );
  console.log(
    styleText(
      'dim',
      '  more visibility and makes agents more likely to use it proactively.',
    ),
  );

  const mcpPath = join(root, '.cursor', 'mcp.json');
  if (hasMcpServer(root, mcpPath, 'mcpServers')) {
    console.log(styleText('green', '  MCP server') + ' already configured');
  } else {
    addMcpServer(root, mcpPath, 'mcpServers', style);
    console.log(
      styleText('green', '  MCP server') + ' registered in .cursor/mcp.json',
    );
  }

  // Ensure .cursor is gitignored (hooks and MCP config may contain local paths)
  ensureGitignored(root, '.cursor');

  // .agents/skills/lat-md/SKILL.md — skill for authoring lat.md files
  await writeAgentsSkill(root, latDir, hashes, ask);

  console.log('');
  console.log(
    styleText('yellow', '  Note:') +
      ' Enable MCP in Cursor: Settings → Features → MCP → check "Enable MCP"',
  );
}

async function setupCopilot(
  root: string,
  latDir: string,
  hashes: Record<string, string>,
  ask: (message: string) => Promise<boolean>,
  style: LatCommandStyle,
): Promise<void> {
  // .github/copilot-instructions.md — append-mode with markers
  const hash = await appendTemplateSection(
    root,
    latDir,
    '.github/copilot-instructions.md',
    readAgentsTemplate(basename(latDir)),
    'Instructions (.github/copilot-instructions.md)',
    '  ',
    ask,
  );
  if (hash) hashes['.github/copilot-instructions.md'] = hash;

  // .vscode/mcp.json
  console.log('');
  console.log(
    styleText(
      'dim',
      '  Agents can call `lat` from the command line, but an MCP server gives lat',
    ),
  );
  console.log(
    styleText(
      'dim',
      '  more visibility and makes agents more likely to use it proactively.',
    ),
  );

  const mcpPath = join(root, '.vscode', 'mcp.json');
  if (hasMcpServer(root, mcpPath, 'servers')) {
    console.log(styleText('green', '  MCP server') + ' already configured');
  } else {
    addMcpServer(root, mcpPath, 'servers', style);
    console.log(
      styleText('green', '  MCP server') + ' registered in .vscode/mcp.json',
    );
  }

  // .agents/skills/lat-md/SKILL.md — skill for authoring lat.md files
  await writeAgentsSkill(root, latDir, hashes, ask);
}

async function setupPi(
  root: string,
  latDir: string,
  hashes: Record<string, string>,
  ask: (message: string) => Promise<boolean>,
  style: LatCommandStyle,
): Promise<void> {
  // AGENTS.md — Pi reads this natively
  // (already created in the shared step if any non-Claude agent is selected)

  // .pi/extensions/lat.ts — extension that registers tools + lifecycle hooks
  console.log('');
  console.log(
    styleText(
      'dim',
      '  The Pi extension registers lat tools and hooks into the agent lifecycle',
    ),
  );
  console.log(
    styleText(
      'dim',
      `  to inject search context and validate ${basename(latDir)}/ before finishing.`,
    ),
  );

  const template = readPiExtensionTemplate(basename(latDir)).replace(
    '__LAT_INVOCATION__',
    () => JSON.stringify(agentInvocation(style, resolveLatInvocation())),
  );

  const hash = await writeTemplateFile(
    root,
    latDir,
    '.pi/extensions/lat.ts',
    template,
    'pi-extension.ts',
    'Extension (.pi/extensions/lat.ts)',
    '  ',
    ask,
  );
  if (hash) hashes['.pi/extensions/lat.ts'] = hash;

  // .pi/skills/lat-md/SKILL.md — skill for authoring lat.md files
  console.log('');
  console.log(
    styleText(
      'dim',
      `  The lat-md skill teaches the agent how to write and maintain ${basename(latDir)}/ files.`,
    ),
  );

  const skillTemplate = readSkillTemplate(basename(latDir));
  const skillHash = await writeTemplateFile(
    root,
    latDir,
    '.pi/skills/lat-md/SKILL.md',
    skillTemplate,
    'skill.md',
    'Skill (.pi/skills/lat-md/SKILL.md)',
    '  ',
    ask,
  );
  if (skillHash) hashes['.pi/skills/lat-md/SKILL.md'] = skillHash;

  // Ensure .pi is gitignored (extension contains local absolute paths)
  ensureGitignored(root, '.pi');
}

async function setupOpenCode(
  root: string,
  latDir: string,
  hashes: Record<string, string>,
  ask: (message: string) => Promise<boolean>,
  style: LatCommandStyle,
): Promise<void> {
  // AGENTS.md — OpenCode reads this natively
  // (already created in the shared step if any non-Claude agent is selected)

  // .opencode/plugins/lat.ts — plugin that registers tools + lifecycle hooks
  console.log('');
  console.log(
    styleText(
      'dim',
      '  The OpenCode plugin registers lat tools and hooks into the session',
    ),
  );
  console.log(
    styleText(
      'dim',
      `  lifecycle to validate ${basename(latDir)}/ when the agent finishes.`,
    ),
  );

  const template = readOpenCodePluginTemplate(basename(latDir)).replace(
    '__LAT_INVOCATION__',
    () => JSON.stringify(agentInvocation(style, resolveLatInvocation())),
  );

  const hash = await writeTemplateFile(
    root,
    latDir,
    '.opencode/plugins/lat.ts',
    template,
    'opencode-plugin.ts',
    'Plugin (.opencode/plugins/lat.ts)',
    '  ',
    ask,
  );
  if (hash) hashes['.opencode/plugins/lat.ts'] = hash;

  // .agents/skills/lat-md/SKILL.md — skill for authoring lat.md files
  await writeAgentsSkill(root, latDir, hashes, ask);

  // Ensure .opencode is gitignored (plugin contains local absolute paths)
  ensureGitignored(root, '.opencode');
}

async function setupCodex(
  root: string,
  latDir: string,
  hashes: Record<string, string>,
  ask: (message: string) => Promise<boolean>,
  style: LatCommandStyle,
): Promise<void> {
  // AGENTS.md — Codex reads this natively
  // (already created in the shared step if any non-Claude agent is selected)

  // .codex/config.toml — MCP server registration
  console.log('');
  console.log(
    styleText(
      'dim',
      '  Agents can call `lat` from the command line, but an MCP server gives lat',
    ),
  );
  console.log(
    styleText(
      'dim',
      '  more visibility and makes agents more likely to use it proactively.',
    ),
  );

  const mcpPath = join(root, '.codex', 'config.toml');
  if (hasCodexMcpServer(root, mcpPath)) {
    console.log(styleText('green', '  MCP server') + ' already configured');
  } else {
    addCodexMcpServer(root, mcpPath, style);
    console.log(
      styleText('green', '  MCP server') + ' registered in .codex/config.toml',
    );
  }

  // Ensure .codex is gitignored (config contains local absolute paths)
  ensureGitignored(root, '.codex');

  // .agents/skills/lat-md/SKILL.md — skill for authoring lat.md files
  await writeAgentsSkill(root, latDir, hashes, ask);

  // .codex/skills/lat-md/SKILL.md — Codex-specific skills directory
  console.log('');
  console.log(
    styleText(
      'dim',
      `  The lat-md skill teaches the agent how to write and maintain ${basename(latDir)}/ files.`,
    ),
  );

  const skillTemplate = readSkillTemplate(basename(latDir));
  const skillHash = await writeTemplateFile(
    root,
    latDir,
    '.codex/skills/lat-md/SKILL.md',
    skillTemplate,
    'skill.md',
    'Skill (.codex/skills/lat-md/SKILL.md)',
    '  ',
    ask,
  );
  if (skillHash) hashes['.codex/skills/lat-md/SKILL.md'] = skillHash;
}

// ── Embedding setup ─────────────────────────────────────────────────

type EmbeddingBackend = 'local' | 'remote';

async function readStoredEmbeddingModel(
  latDir: string,
): Promise<string | null> {
  if (!existsSync(join(latDir, '.cache', 'search.db'))) return null;

  const db = openDb(latDir, undefined, true);
  try {
    return await getStoredModel(db);
  } finally {
    await closeDb(db);
  }
}

async function offerReindex(
  root: string,
  latDir: string,
  backend: EmbeddingBackend,
  remoteModel: string | null,
  storedModel: string | null,
  interactive: boolean,
): Promise<void> {
  if (!storedModel) return;

  const storedBackend: EmbeddingBackend = storedModel.startsWith('local:')
    ? 'local'
    : 'remote';
  const modelMatches =
    backend === 'local'
      ? storedBackend === 'local'
      : remoteModel
        ? storedModel === remoteModel
        : storedBackend === 'remote';
  if (modelMatches) return;

  const command = `lat reindex --${backend}`;
  const configuredModel =
    backend === 'remote' && remoteModel
      ? `'${remoteModel}'`
      : `${backend} embeddings`;
  console.log('');
  console.log(
    styleText('yellow', 'Existing search index') +
      ` — built with '${storedModel}', but this repo is now configured for ${configuredModel}.`,
  );

  if (!interactive) {
    console.log('  Run ' + styleText('cyan', command) + ' to rebuild it.');
    return;
  }

  const action = await selectMenu(
    [
      { label: 'Reindex now', value: 'now' },
      { label: `Later (run ${command})`, value: 'later' },
    ],
    `Rebuild the existing index with ${backend} embeddings?`,
    0,
  );
  if (action !== 'now') return;

  const result = await reindexCommand(
    { latDir, projectRoot: root, styler: makeStyler(), mode: 'cli' },
    backend === 'local' ? { local: true } : { remote: true },
  );
  if (result.isError) console.error(result.output);
  else if (result.output) console.log(result.output);
}

async function setupEmbeddingsForInit(
  root: string,
  latDir: string,
  interactive: boolean,
  configureDefault: boolean,
): Promise<void> {
  // Read the index first: its recorded model lets the resolution below reuse a
  // known vector width instead of probing the endpoint over the network.
  let storedModel: string | null = null;
  try {
    storedModel = await readStoredEmbeddingModel(latDir);
  } catch (err) {
    console.log('');
    console.log(
      styleText('yellow', 'Could not inspect the existing search index:') +
        ' ' +
        (err as Error).message,
    );
  }

  let key: string | undefined;
  let remoteModel: string | null = null;
  /** The key resolved, but the endpoint could not be reached to confirm it. */
  let remoteUnverified = false;
  try {
    key = getLlmKey();
    if (key) {
      // Resolve through the same path `lat search` uses. Building the embedder
      // from the bare key would ignore a configured OpenAI-compatible endpoint
      // and report a gateway key as an unusable provider.
      //
      // Provider resolution is pure, so a failure here is a fact about the
      // configuration: the key really is unusable. Everything after it touches
      // the network and can fail transiently, which is a different thing.
      detectProvider(key, getRemoteSelection(latDir));
      try {
        remoteModel = modelKey(
          await embedderFromEnv(latDir, undefined, storedModel),
        );
      } catch (err) {
        remoteUnverified = true;
        console.log('');
        console.log(
          styleText('yellow', 'Could not verify the embedding endpoint:') +
            ' ' +
            (err as Error).message,
        );
      }
    }
  } catch (err) {
    key = undefined;
    console.log('');
    console.log(
      styleText('yellow', 'Embedding key unavailable:') +
        ' ' +
        (err as Error).message,
    );
  }

  const repoIsLocal = getRepoEmbedding(latDir) === 'local';
  const storedBackend: EmbeddingBackend | null = storedModel
    ? storedModel.startsWith('local:')
      ? 'local'
      : 'remote'
    : null;
  const existingBackend: EmbeddingBackend | null = repoIsLocal
    ? 'local'
    : storedBackend;

  // Fresh/outdated non-interactive setups default local. Current non-interactive
  // setups preserve their backend. Only a TTY presents and applies a key choice.
  //
  // The local-first default deliberately skips a repo with a *working* hosted
  // setup (hosted index + a provider/model-compatible key): `configureDefault`
  // re-fires
  // on every INIT_VERSION bump, so pinning local here would keep undoing a
  // deliberate choice — and without a TTY the user has no way to object. A
  // hosted index with no key is unusable, so that one does fall back to local.
  const workingHosted =
    existingBackend === 'remote' && remoteModel === storedModel;
  // An unreachable endpoint says nothing about whether the hosted setup works.
  // Pinning local here would discard a working gateway over a transient
  // failure, so the backend is left exactly as the repo recorded it.
  const preserveHosted = remoteUnverified && existingBackend === 'remote';
  let backend: EmbeddingBackend;
  let configuredNow = false;
  if (key && interactive) {
    console.log('');
    console.log(styleText('bold', 'Semantic search'));
    console.log('');
    console.log(
      '  An embedding API key is configured. Choose whether this repo should use',
    );
    console.log('  the bundled offline model or hosted embeddings.');
    console.log('');

    const defaultIndex = existingBackend
      ? existingBackend === 'local'
        ? 0
        : 1
      : configureDefault
        ? 0
        : 1;
    const selected = await selectMenu(
      [
        { label: 'Local — bundled, offline (recommended)', value: 'local' },
        { label: 'Hosted — use LAT_LLM_KEY', value: 'remote' },
      ],
      'Embedding backend',
      defaultIndex,
    );
    if (!selected) return;
    backend = selected as EmbeddingBackend;
    setRepoEmbedding(latDir, backend === 'local' ? 'local' : null);
    configuredNow = true;
  } else if (configureDefault && !workingHosted && !preserveHosted) {
    backend = 'local';
    setRepoEmbedding(latDir, 'local');
    configuredNow = true;

    console.log('');
    console.log(styleText('bold', 'Semantic search'));
    console.log('');
    console.log(
      '  lat.md includes semantic search (' +
        styleText('cyan', 'lat search') +
        ') that lets agents find',
    );
    console.log(
      '  relevant documentation by meaning, not just keywords. This repo is configured',
    );
    console.log(
      '  to use the bundled local model — fully offline, with no API key required.',
    );
  } else {
    backend = existingBackend ?? (key ? 'remote' : 'local');
    if (preserveHosted) {
      console.log('');
      console.log(
        '  Leaving this repo on hosted embeddings: its index was built for a',
      );
      console.log(
        '  configured endpoint that could not be reached from here just now.',
      );
    }
  }

  if (configuredNow && backend === 'local' && !key) {
    console.log('');
    console.log(
      '  Power users can opt into hosted embeddings by setting ' +
        styleText('cyan', 'LAT_LLM_KEY') +
        ' and running',
    );
    console.log('  ' + styleText('cyan', 'lat reindex --remote') + '.');
    console.log(
      '  Any OpenAI-compatible endpoint also needs ' +
        styleText('cyan', 'LAT_LLM_BASE_URL') +
        ' and ' +
        styleText('cyan', 'LAT_LLM_MODEL') +
        '.',
    );
  }

  await offerReindex(
    root,
    latDir,
    backend,
    remoteModel,
    storedModel,
    interactive,
  );
}

// ── Post-onboarding guidance ─────────────────────────────────────────

const nextStepPrompt = (vaultLabel: string): string =>
  `Read through this codebase and set up ${vaultLabel} to document its architecture, key design decisions, and domain concepts. Run \`lat check\` when done.`;

function printNextSteps(selectedAgents: string[], vaultLabel: string): void {
  const hasClaudeCode = selectedAgents.includes('claude');
  const ideAgents = selectedAgents.filter((a) => a !== 'claude');

  const ideLabels: Record<string, string> = {
    cursor: 'Cursor',
    copilot: 'VS Code Copilot',
    pi: 'Pi',
    opencode: 'OpenCode',
    codex: 'Codex',
  };

  if (!hasClaudeCode && ideAgents.length === 0) return;

  console.log('');
  console.log(
    styleText('bold', 'Next step') +
      ' — have your agent document this codebase:',
  );

  if (hasClaudeCode) {
    console.log('');
    console.log('  ' + styleText('bold', 'Claude Code:'));
    console.log(
      '    ' + styleText('cyan', `claude "${nextStepPrompt(vaultLabel)}"`),
    );
  }

  if (ideAgents.length > 0) {
    const names = ideAgents.map((a) => ideLabels[a] || a).join(' / ');
    console.log('');
    console.log(
      '  ' + styleText('bold', `${names}`) + ' — paste into agent chat:',
    );
    console.log('    ' + styleText('cyan', nextStepPrompt(vaultLabel)));
  }
}

// ── Main init flow ───────────────────────────────────────────────────

export function readLogo(): string {
  return readFileSync(join(findTemplatesDir(), 'logo.txt'), 'utf-8');
}

export function ensureLatLocalConfigIgnored(latDir: string): void {
  const root = dirname(latDir);
  const path = projectWritePath(root, join(latDir, '.gitignore'));
  const entry = 'config.local.yaml';
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (current.split(/\r?\n/).includes(entry)) return;
  const prefix = current && !current.endsWith('\n') ? `${current}\n` : current;
  writeProjectFile(root, path, `${prefix}${entry}\n`);
}

/**
 * Vault directory name for this init run: an explicit `--vault` wins, then an
 * existing config file, then the default. Validated with the same rule the
 * config parser applies, so init cannot record a name it would later reject.
 */
function resolveInitVaultName(root: string, requested?: string): string {
  if (requested !== undefined) {
    const problem = validateLatticeDirName(requested);
    if (problem) {
      console.error(styleText('red', `--vault ${problem}`));
      process.exit(1);
    }
    return requested;
  }
  // A malformed config must not be scaffolded over: every other command refuses
  // to run until it is fixed, and init is the one that would repair it.
  const configError = projectConfigError(root);
  if (configError) {
    console.error(styleText('red', configError));
    console.error(styleText('dim', 'Fix or remove it to continue.'));
    process.exit(1);
  }
  return readLatProjectConfig(root).config.dir ?? DEFAULT_LATTICE_DIR_NAME;
}

/**
 * Record the vault directory in the project config, preserving keys lat does
 * not own. Nothing is written when the configured name already matches, so a
 * repo that keeps `lat.md/` stays byte-identical to what earlier versions
 * produced — but switching *back* to `lat.md` after a rename must still be
 * recorded, or the config keeps pointing at the old directory and the new vault
 * is unreachable.
 */
function writeInitProjectConfig(
  root: string,
  vaultName: string,
  configuredName: string | undefined,
): void {
  if (vaultName === configuredName) return;
  if (vaultName === DEFAULT_LATTICE_DIR_NAME && configuredName === undefined)
    return;
  const path = join(root, LAT_CONFIG_FILE);
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        existing = parsed as Record<string, unknown>;
    } catch {
      // A malformed file is already a loud error everywhere else; replace it.
    }
  }
  writeProjectFile(
    root,
    path,
    `${JSON.stringify({ ...existing, dir: vaultName }, null, 2)}\n`,
  );
}

/**
 * The scaffold ships its index as `lat.md`, named after the default vault.
 * Repoint it at the real directory name, since the index file must share its
 * directory's name for `lat check` to find it.
 */
function renameScaffoldedIndex(latDir: string): void {
  // The scaffolded index ships as `lat.md` — the default directory name, which
  // already carries the `.md` suffix. Not `${DEFAULT_LATTICE_DIR_NAME}.md`.
  const templateName = DEFAULT_LATTICE_DIR_NAME;
  const indexName = latticeIndexFileName(latDir);
  if (indexName === templateName) return;
  const templateIndex = join(latDir, templateName);
  if (!existsSync(templateIndex)) return;
  renameSync(templateIndex, join(latDir, indexName));
}

/** Report the index file `lat check` will ask for when a vault already exists. */
function reportVaultIndex(latDir: string): void {
  const indexName = latticeIndexFileName(latDir);
  if (existsSync(join(latDir, indexName))) return;

  const legacyName = DEFAULT_LATTICE_DIR_NAME;
  if (indexName !== legacyName && existsSync(join(latDir, legacyName))) {
    // Renamed vault that still carries the old index file. Suggesting `git mv`
    // keeps the rename reviewable instead of rewriting history silently.
    console.log(
      styleText('yellow', `  ${legacyName} is named after the default vault`) +
        ` — rename it to ${indexName}:`,
    );
    console.log(
      styleText(
        'dim',
        `    git mv ${latDir}/${legacyName} ${latDir}/${indexName}`,
      ),
    );
    return;
  }
  console.log(
    styleText('dim', `  ${indexName} is missing — `) +
      'lat check will list the entries it needs.',
  );
}

export async function initCmd(
  targetDir?: string,
  options: { vault?: string } = {},
): Promise<void> {
  console.log(styleText('cyan', readLogo()));

  // Upfront version check — let the user upgrade before proceeding
  process.stdout.write(styleText('dim', 'Checking latest version...'));
  const latest = await fetchLatestVersion();
  const local = getLocalVersion();
  if (latest && latest !== local) {
    console.log(
      ' ' +
        styleText('yellow', 'update available:') +
        ' ' +
        local +
        ' → ' +
        styleText('green', latest) +
        ' — run ' +
        styleText('cyan', 'npm install -g lat.md') +
        ' to update.',
    );
    console.log('');
  } else {
    console.log(' ' + styleText('green', `latest version is used (${local})`));
  }

  const root = resolve(targetDir ?? process.cwd());
  const vaultName = resolveInitVaultName(root, options.vault);
  const latDir = join(root, vaultName);
  projectWritePath(root, latDir);
  const storedInitVersion = readInitVersion(latDir);

  const interactive = process.stdin.isTTY ?? false;

  // Readline is created AFTER the selectMenu loop below.
  // selectMenu puts stdin into raw mode with its own 'data' listener;
  // if readline is already attached it receives those raw keypresses,
  // corrupting its internal state and causing rl.question() to hang/exit.
  let rl: ReturnType<typeof createInterface> | null = null;

  const ask = async (message: string): Promise<boolean> => {
    if (!rl) return true;
    return confirm(rl, message);
  };

  try {
    // Step 1: vault directory
    const vaultLabel = `${vaultName}/`;
    if (existsSync(latDir)) {
      console.log(styleText('green', vaultLabel) + ' already exists');
      reportVaultIndex(latDir);
    } else {
      // No rl yet — selectMenu hasn't run, so use a one-off confirm
      if (interactive) {
        const tmpRl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        try {
          if (
            !(await confirm(tmpRl, `Create ${basename(latDir)}/ directory?`))
          ) {
            console.log('Aborted.');
            return;
          }
        } finally {
          tmpRl.close();
        }
      }
      const templateDir = join(findTemplatesDir(), 'init');
      mkdirSync(latDir, { recursive: true });
      cpSync(templateDir, latDir, { recursive: true });
      renameScaffoldedIndex(latDir);
      console.log(styleText('green', `Created ${basename(latDir)}/`));
    }

    writeInitProjectConfig(
      root,
      vaultName,
      readLatProjectConfig(root).config.dir,
    );
    ensureLatLocalConfigIgnored(latDir);
    ensureGitignored(root, '.lat-build');

    // Step 2: Configure fresh/outdated setups, ask interactive users about an
    // available key, and offer to rebuild an index whose backend differs. This
    // happens before agent selection so "no agents" still completes it.
    await setupEmbeddingsForInit(
      root,
      latDir,
      interactive,
      storedInitVersion === null || storedInitVersion < INIT_VERSION,
    );

    // Step 3: Which coding agents do you use? (interactive select menu)
    console.log('');

    const allAgents = [
      { label: 'Claude Code', value: 'claude' },
      { label: 'Pi', value: 'pi' },
      { label: 'Cursor', value: 'cursor' },
      { label: 'VS Code Copilot', value: 'copilot' },
      { label: 'OpenCode', value: 'opencode' },
      { label: 'Codex', value: 'codex' },
    ];

    const selectedAgents = await checklistMenu(
      allAgents,
      'Which coding agents do you use?',
      readInitAgents(latDir),
    );

    const useClaudeCode = selectedAgents.includes('claude');
    const usePi = selectedAgents.includes('pi');
    const useCursor = selectedAgents.includes('cursor');
    const useCopilot = selectedAgents.includes('copilot');
    const useOpenCode = selectedAgents.includes('opencode');
    const useCodex = selectedAgents.includes('codex');

    const anySelected = selectedAgents.length > 0;
    const needsLatCommand =
      useClaudeCode ||
      usePi ||
      useCursor ||
      useCopilot ||
      useOpenCode ||
      useCodex;

    // Step 4: How should agents run lat?
    let commandStyle: LatCommandStyle = 'local';
    if (anySelected && needsLatCommand && interactive) {
      console.log('');
      const localBin = resolveLatBin();
      const styleOptions: SelectOption[] = [
        { label: 'lat', value: 'global' },
        { label: localBin, value: 'local' },
      ];
      const styleChoice = await selectMenu(
        styleOptions,
        'How should agents run lat?',
        0,
      );
      if (!styleChoice) {
        console.log('Aborted.');
        return;
      }
      commandStyle = styleChoice as LatCommandStyle;
    }

    // Now that selectMenu is done, it's safe to create the readline interface.
    // selectMenu has restored stdin to its original state (paused, non-raw).
    if (interactive) {
      rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
    }

    if (!anySelected) {
      // Embedding setup is complete even when the user does not configure an
      // agent. Stamp the version so future non-interactive runs do not reapply
      // fresh/outdated defaults and overwrite the chosen backend.
      writeInitMeta(latDir, {});
      if (interactive) writeInitAgents(latDir, selectedAgents);
      console.log('');
      console.log(
        styleText('dim', 'No agents selected. You can re-run') +
          ' lat init ' +
          styleText('dim', 'later.'),
      );
      return;
    }

    console.log('');
    const template = readAgentsTemplate(basename(latDir));
    const fileHashes: Record<string, string> = {};

    // Step 5: AGENTS.md — the single instruction file every agent reads.
    // Claude Code included, because its CLAUDE.md is a symlink to this.
    await setupAgentsMd(root, latDir, template, fileHashes, ask);

    // Step 6: Per-agent setup
    if (useClaudeCode) {
      console.log('');
      console.log(styleText('bold', 'Setting up Claude Code...'));
      await setupClaudeCode(root, latDir, fileHashes, ask, commandStyle);
    }

    if (usePi) {
      console.log('');
      console.log(styleText('bold', 'Setting up Pi...'));
      await setupPi(root, latDir, fileHashes, ask, commandStyle);
    }

    if (useCursor) {
      console.log('');
      console.log(styleText('bold', 'Setting up Cursor...'));
      await setupCursor(root, latDir, fileHashes, ask, commandStyle);
    }

    if (useCopilot) {
      console.log('');
      console.log(styleText('bold', 'Setting up VS Code Copilot...'));
      await setupCopilot(root, latDir, fileHashes, ask, commandStyle);
    }

    if (useOpenCode) {
      console.log('');
      console.log(styleText('bold', 'Setting up OpenCode...'));
      await setupOpenCode(root, latDir, fileHashes, ask, commandStyle);
    }

    if (useCodex) {
      console.log('');
      console.log(styleText('bold', 'Setting up Codex...'));
      await setupCodex(root, latDir, fileHashes, ask, commandStyle);
    }

    // Record init version and file hashes so `lat check` can detect stale setups
    writeInitMeta(latDir, fileHashes);
    if (interactive) writeInitAgents(latDir, selectedAgents);

    console.log('');
    console.log(
      styleText('green', 'Done!') +
        ' Run ' +
        styleText('cyan', 'lat check') +
        ' to validate your setup.',
    );

    // Suggest ripgrep if not available
    const { hasRipgrep } = await import('@lat.md/core/code-refs');
    if (!(await hasRipgrep())) {
      console.log('');
      console.log(
        styleText('yellow', 'Tip:') +
          ' Install ' +
          styleText('cyan', 'ripgrep') +
          ' (rg) for faster code scanning.' +
          ' See ' +
          styleText(
            'underline',
            'https://github.com/BurntSushi/ripgrep#installation',
          ),
      );
    }

    // Post-onboarding: suggest having the agent document the codebase
    printNextSteps(selectedAgents, `${basename(latDir)}/`);
  } finally {
    rl?.close();
  }
}
