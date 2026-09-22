import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ensureMeta,
  ensureSectionsSchema,
  SearchDb,
} from '../src/search/db.js';
import {
  lexicalTokens,
  lexicalVersion,
  loadSegmenter,
  segmenterWords,
  setSegmenterWords,
} from '../src/search/lexical.js';
import { indexSections } from '../src/search/index.js';
import { literalFtsQuery, searchSections } from '../src/search/search.js';

const dirs: string[] = [];

/** A project whose vault is `lat.md/`, optionally with a `lat.config.json`. */
function fixture(markdown: string, config?: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'lat-segmenter-'));
  dirs.push(root);
  const lat = join(root, 'lat.md');
  mkdirSync(lat);
  writeFileSync(join(lat, 'guide.md'), markdown);
  if (config !== undefined)
    writeFileSync(join(root, 'lat.config.json'), JSON.stringify(config));
  return { root, lat };
}

/** A stub embedder, so these tests exercise the lexical channel only. */
const simple = {
  name: 'local:test',
  dimensions: 2,
  maxInputTokens: 256,
  tokenizerFingerprint: 'characters-v1',
  countTokens: (t: string) => Array.from(t).length,
  embed: async (texts: string[]) =>
    texts.map((t) => (t.includes('needle') ? [1, 0] : [0, 1])),
};

async function indexed(markdown: string, config?: unknown) {
  const f = fixture(markdown, config);
  const db = new SearchDb(join(f.root, 'test.db'));
  await ensureMeta(db);
  await ensureSectionsSchema(db, 2);
  await indexSections(f.lat, db, simple);
  return { ...f, db };
}

beforeAll(async () => {
  await loadSegmenter();
});

afterEach(async () => {
  setSegmenterWords([]);
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('CJK segmentation', () => {
  // @lat: [[tests/lexical-segmenter#Lexical Segmenter#CJK Segmentation#Splits a Han run into words]]
  it('splits a Han run into the words the dictionary knows', () => {
    const tokens = lexicalTokens('失败请求的重试策略');
    // A character run between punctuation is a single token to a whitespace
    // tokenizer, which is what made 重试 unsearchable.
    expect(tokens).toContain('重试');
    expect(tokens).toContain('策略');
    expect(tokens).not.toContain('失败请求的重试策略');
  });

  // @lat: [[tests/lexical-segmenter#Lexical Segmenter#CJK Segmentation#Leaves non-Han runs to the stemmer]]
  it('leaves non-Han runs alone and still stems Latin ones', () => {
    expect(lexicalTokens('API_TOKEN café')).toEqual(['api_token', 'café']);
    expect(lexicalTokens('Buildings Running')).toEqual(['build', 'run']);
    // Kana and hangul are not what a Chinese segmenter knows.
    expect(lexicalTokens('テストする')).toEqual(['テストする']);
    expect(lexicalTokens('안녕하세요')).toEqual(['안녕하세요']);
  });

  // @lat: [[tests/lexical-segmenter#Lexical Segmenter#CJK Segmentation#Loads the segmenter only for Han text]]
  it('loads the segmenter only when Han text is tokenized', () => {
    // A separate process, and the source rather than the build output: an
    // instance this file already loaded the dictionary into could not show that
    // the import is deferred, and a stale `dist/` could hide that it is not.
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
        const m = await import('./src/search/lexical.js');
        const before = m.segmenterLoaded();
        m.lexicalTokens('apple banana');
        const after = m.segmenterLoaded();
        let guard = 'no throw';
        try { m.lexicalTokens('重试策略'); }
        catch (error) { guard = String(/not loaded/.test(error.message)); }
        await m.ensureSegmenterFor(['重试策略']);
        console.log(
          [before, after, guard, m.segmenterLoaded(),
           m.lexicalTokens('重试策略').join(',')].join(' '),
        );
        `,
      ],
      { cwd: join(import.meta.dirname, '..'), encoding: 'utf8' },
    );
    expect(result.stderr, result.stderr).toBe('');
    // Latin-only text neither loads the dictionary nor changes its output.
    // Han text the glossary does not cover fails loudly instead of emitting the
    // whole-clause token that made the term unsearchable in the first place.
    expect(result.stdout.trim()).toBe('false false true true 重试,策略');
  });
});

describe('project glossary', () => {
  // @lat: [[tests/lexical-segmenter#Lexical Segmenter#Project Glossary#Keeps a listed word whole]]
  it('keeps a listed word whole, without the segmenter arbitration', () => {
    expect(lexicalTokens('幂等设计')).not.toContain('幂等');
    setSegmenterWords(['幂等']);
    // The rest of the run is still segmented, not swallowed by the match.
    expect(lexicalTokens('幂等设计')).toEqual(['幂等', '设计']);
  });

  // @lat: [[tests/lexical-segmenter#Lexical Segmenter#Project Glossary#Folds case before matching]]
  it('folds a listed word to lower case before matching', () => {
    // Tokenization lowercases its input, so an entry kept in its original case
    // would validate and then silently never match anything.
    setSegmenterWords(['API']);
    expect(segmenterWords()).toEqual(['api']);
    const tokens = lexicalTokens('幂等API');
    expect(tokens).toContain('api');
  });

  // @lat: [[tests/lexical-segmenter#Lexical Segmenter#Project Glossary#Never splits a non-Han run]]
  it('never splits a non-Han run, so an entry cannot widen other words', () => {
    // A Latin run is already one token, so applying the glossary to it could
    // only break a word apart — the opposite of what an entry is for.
    setSegmenterWords(['spring']);
    expect(lexicalTokens('springboard')).toEqual(['springboard']);
    expect(literalFtsQuery('springboard')).toBe('"springboard"');
  });

  // @lat: [[tests/lexical-segmenter#Lexical Segmenter#Project Glossary#Replaces the glossary rather than accumulating]]
  it('replaces the glossary rather than accumulating one', () => {
    setSegmenterWords(['幂等']);
    expect(lexicalTokens('幂等设计')).toContain('幂等');
    // A process that serves one project must not be able to answer for another
    // with the wrong dictionary, so adoption replaces rather than extends.
    setSegmenterWords(['回滚']);
    expect(lexicalTokens('幂等设计')).not.toContain('幂等');
    expect(lexicalTokens('回滚机制')).toContain('回滚');
    expect(segmenterWords()).toEqual(['回滚']);
  });

  // @lat: [[tests/lexical-segmenter#Lexical Segmenter#Project Glossary#Folds the glossary into the lexical version]]
  it('folds the glossary into the lexical version', () => {
    expect(lexicalVersion(['幂等'])).not.toBe(lexicalVersion());
    expect(lexicalVersion(['幂等'])).toBe(lexicalVersion(['幂等']));
    // Order must not matter, or a reordered list would force a rebuild.
    expect(lexicalVersion(['a', 'b'])).toBe(lexicalVersion(['b', 'a']));
    // A multi-character word must not collide with its parts.
    expect(lexicalVersion(['ab'])).not.toBe(lexicalVersion(['a', 'b']));
  });
});

describe('Chinese retrieval', () => {
  // @lat: [[tests/lexical-segmenter#Lexical Segmenter#Chinese Retrieval#Finds a term inside a longer clause]]
  it('finds a term that only appears inside a longer clause', async () => {
    const f = await indexed(
      '# 支付服务\n\n失败请求的重试策略与退避规则，指数退避从一秒起步。\n',
    );
    try {
      // Before segmentation this clause was one token, so 重试 matched nothing.
      const results = await searchSections(f.db, '重试', simple, 10);
      expect(results[0]?.id).toBe('lat.md/guide#支付服务');
      expect(results[0]?.lexicalRank).toBe(1);
    } finally {
      await f.db.close();
    }
  });

  // @lat: [[tests/lexical-segmenter#Lexical Segmenter#Chinese Retrieval#Adopts the glossary the index recorded]]
  it('adopts the glossary the index recorded, not the one in the config', async () => {
    const f = await indexed('# 支付服务\n\n幂等设计保证重复投递安全。\n', {
      'segmenter-words': ['幂等'],
    });
    try {
      const results = await searchSections(f.db, '幂等', simple, 10);
      expect(results[0]?.lexicalRank).toBe(1);
    } finally {
      await f.db.close();
    }
    // Reading a different project's index answers with that index's glossary.
    setSegmenterWords(['回滚']);
    expect(lexicalTokens('幂等设计')).not.toContain('幂等');
    const other = await indexed('# 另一个项目\n\n幂等设计。\n');
    try {
      await searchSections(other.db, '幂等', simple, 10);
      expect(segmenterWords()).toEqual([]);
    } finally {
      await other.db.close();
    }
  });

  // @lat: [[tests/lexical-segmenter#Lexical Segmenter#Chinese Retrieval#Re-tokenizes when the config glossary changes]]
  it('re-tokenizes the index when the config glossary changes', async () => {
    const f = await indexed('# 支付服务\n\n幂等设计。\n', {
      'segmenter-words': ['幂等'],
    });
    try {
      const body = async () =>
        (
          await f.db.execute(
            'SELECT body FROM lexical_chunks ORDER BY id LIMIT 1',
          )
        ).rows[0].body as string;
      // The glossary is what makes 幂等 one token; jieba alone splits it.
      expect(await body()).toContain('幂等');

      // Re-indexing an unchanged project reuses the rows it already has.
      await indexSections(f.lat, f.db, simple);
      expect(await body()).toContain('幂等');

      // Dropping the word from the config has to re-tokenize: the version tag
      // is the only thing that tells the index its rows came from other rules.
      writeFileSync(join(f.root, 'lat.config.json'), JSON.stringify({}));
      await indexSections(f.lat, f.db, simple);
      expect(await body()).not.toContain('幂等');
    } finally {
      await f.db.close();
    }
  });
});
