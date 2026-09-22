import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { findLatticeDir } from '@lat.md/core/project-discovery';
import { findTemplatesDir } from './templates.js';

/** Vault name assumed when `lat gen` runs outside a project. */
const FALLBACK_LATTICE_DIR_NAME = 'lat.md';

/**
 * Replace the `__LAT_DIR__` placeholder with the project's vault directory
 * name. Templates name the vault both in prose and in section-id examples, so
 * leaving the placeholder — or hardcoding `lat.md` — would teach agents to
 * emit ids under the wrong prefix in a project that renamed its vault.
 *
 * The replacer is a function so a directory name containing `$` is inserted
 * literally rather than interpreted as a replacement pattern.
 */
export function substituteLatticeDir(
  template: string,
  latticeDirName: string,
): string {
  return template.replaceAll('__LAT_DIR__', () => latticeDirName);
}

function readTemplate(relativePath: string, latticeDirName: string): string {
  return substituteLatticeDir(
    readFileSync(join(findTemplatesDir(), relativePath), 'utf-8'),
    latticeDirName,
  );
}

export function readAgentsTemplate(latticeDirName: string): string {
  return readTemplate('AGENTS.md', latticeDirName);
}

export function readCursorRulesTemplate(latticeDirName: string): string {
  return readTemplate('cursor-rules.md', latticeDirName);
}

export function readPiExtensionTemplate(latticeDirName: string): string {
  return readTemplate('pi-extension.ts', latticeDirName);
}

export function readOpenCodePluginTemplate(latticeDirName: string): string {
  return readTemplate('opencode-plugin.ts', latticeDirName);
}

export function readSkillTemplate(latticeDirName: string): string {
  return readTemplate(join('skill', 'SKILL.md'), latticeDirName);
}

export async function genCmd(target: string): Promise<void> {
  const latDir = findLatticeDir();
  const latticeDirName = latDir ? basename(latDir) : FALLBACK_LATTICE_DIR_NAME;

  const normalized = target.toLowerCase();
  switch (normalized) {
    case 'agents.md':
    case 'claude.md':
      process.stdout.write(readAgentsTemplate(latticeDirName));
      break;
    case 'cursor-rules.md':
      process.stdout.write(readCursorRulesTemplate(latticeDirName));
      break;
    case 'pi-extension.ts':
      process.stdout.write(readPiExtensionTemplate(latticeDirName));
      break;
    case 'opencode-plugin.ts':
      process.stdout.write(readOpenCodePluginTemplate(latticeDirName));
      break;
    case 'skill.md':
      process.stdout.write(readSkillTemplate(latticeDirName));
      break;
    default:
      console.error(
        `Unknown target: ${target}. Supported: agents.md, claude.md, cursor-rules.md, pi-extension.ts, opencode-plugin.ts, skill.md`,
      );
      process.exit(1);
  }
}
