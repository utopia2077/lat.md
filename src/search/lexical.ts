import { stemWords, STEMMER_VERSION } from '@lat.md/stemmer';
import { digest } from './chunks.js';
import { CREATE_PASSAGE_FTS, type SearchDb } from './db.js';

/**
 * Segmenter identity. It belongs in the lexical version because the index and
 * the query must be tokenized identically — a dictionary change on one side
 * only would silently stop matching instead of failing.
 */
const SEGMENTER_VERSION = 'jieba-rs-2.4.0';

/**
 * Application-side segmentation policy. Bump this whenever the rules in
 * [[src/search/lexical.ts#splitRun]] change which tokens an input produces.
 * The tag is the only thing that makes [[src/search/lexical.ts#synchronizeLexical]]
 * re-tokenize an existing index; without a bump it keeps the previous rows and
 * the index silently disagrees with what the query side now produces.
 */
const SEGMENTATION_POLICY = 'cjk-words-v3';

/**
 * Lexical policy version. The project's glossary is part of it: the glossary
 * changes the tokens a passage produces, so an index built without it has to be
 * re-tokenized rather than silently kept.
 */
export function lexicalVersion(words: readonly string[] = []): string {
  const glossary = words.length
    ? `:glossary-${digest([...words].sort().join('\0')).slice(0, 12)}`
    : '';
  return `${STEMMER_VERSION}:${SEGMENTER_VERSION}:${SEGMENTATION_POLICY}:live-statistics-v1${glossary}`;
}

/** Meta key holding the glossary the index was tokenized with. */
export const SEGMENTER_WORDS_KEY = 'segmenter_words';

/**
 * The segmenter is a Chinese one. Han script is what it has vocabulary for;
 * kana and hangul runs stay whole rather than being split by a dictionary that
 * does not know them.
 */
const HAN = /\p{Script=Han}/u;
const WORD_RUN = /[\p{L}\p{N}_]+/gu;
const ASCII_WORD = /^[a-z]+$/;

type Cut = (text: string, hmm?: boolean | null) => string[];

let cut: Cut | undefined;

/** Load the CJK segmenter module. A no-op after the first call. */
export async function loadSegmenter(): Promise<void> {
  cut ??= await import('jieba-wasm').then(
    (module) => module.cut,
    (error: unknown) => {
      throw new Error(
        `The CJK segmenter (jieba-wasm) could not be loaded: ${
          error instanceof Error ? error.message : String(error)
        }. Reinstall dependencies to restore Chinese search.`,
        { cause: error },
      );
    },
  );
}

/** Whether the segmenter module has been loaded. Exposed for tests. */
export function segmenterLoaded(): boolean {
  return cut !== undefined;
}

/**
 * Load the segmenter only if some text actually needs it. Latin-only projects
 * never pay for the dictionary, which is why the import is dynamic: the module
 * instantiates its WASM at import time.
 */
export async function ensureSegmenterFor(
  texts: Iterable<string>,
): Promise<void> {
  for (const text of texts) if (HAN.test(text)) return loadSegmenter();
}

/** Words kept whole, indexed by first character, longest match first. */
type Glossary = ReadonlyMap<string, readonly string[]>;

/** Glossary words kept whole, indexed by first character, longest match first. */
let glossary: Glossary = new Map();

function indexGlossary(words: readonly string[]): Map<string, string[]> {
  const byFirst = new Map<string, string[]>();
  // Tokenization lowercases its input before matching, so an entry kept in its
  // original case could never match a run. Folding here rather than at the
  // config boundary keeps every entry point — config, stored metadata, direct
  // calls — agreeing on the same words.
  for (const raw of new Set(words)) {
    const word = raw.toLowerCase();
    if (!word) continue;
    const bucket = byFirst.get(word[0]) ?? [];
    bucket.push(word);
    byFirst.set(word[0], bucket);
  }
  // Longest first, so a lookahead match is greedy.
  for (const bucket of byFirst.values())
    bucket.sort((a, b) => b.length - a.length);
  return byFirst;
}

/**
 * Adopt a glossary for subsequent tokenization, replacing any previous one.
 * This is deliberately plain module state rather than the segmenter's own
 * `add_word`: that dictionary is process-global and irreversible, so a process
 * that had tokenized for one project could never tokenize correctly for
 * another.
 */
export function setSegmenterWords(words: readonly string[]): void {
  glossary = indexGlossary(words);
}

/**
 * Words the tokenizer currently keeps whole, as a sorted set — the lookup is
 * bucketed for matching, so this is not the order they were supplied in.
 */
export function segmenterWords(): readonly string[] {
  return [...glossary.values()].flat().sort();
}

/** Segment a span the glossary did not claim, leaving non-Han text alone. */
function segmentSpan(span: string): string[] {
  if (!HAN.test(span)) return [span];
  if (!cut)
    throw new Error(
      'The CJK segmenter is not loaded; await ensureSegmenterFor() before tokenizing.',
    );
  return cut(span, true).filter((word) => word.trim());
}

/**
 * Split one run of letters/digits. A glossary word wins where it matches and
 * the segmenter handles the gaps, so the result depends only on the run and the
 * glossary passed in — never on what this process tokenized earlier.
 *
 * A run without Han is returned whole and the glossary is not consulted at all.
 * Latin text already tokenizes on punctuation, and the CJK segmenter has no
 * vocabulary for kana or hangul, so consulting the glossary here could only
 * break apart a word that was already whole — the opposite of what the glossary
 * is for.
 */
function splitRun(run: string, lookup: Glossary): string[] {
  if (!HAN.test(run)) return [run];
  const out: string[] = [];
  let pending = '';
  let i = 0;
  while (i < run.length) {
    const match = lookup.get(run[i])?.find((word) => run.startsWith(word, i));
    if (match) {
      if (pending) {
        out.push(...segmentSpan(pending));
        pending = '';
      }
      out.push(match);
      i += match.length;
    } else {
      pending += run[i++];
    }
  }
  if (pending) out.push(...segmentSpan(pending));
  return out;
}

/**
 * Tokenize against an explicit glossary, so indexing depends only on the words
 * it was handed rather than on whatever a concurrent query may have adopted
 * into module state partway through.
 */
function tokenize(text: string, lookup: Glossary): string[] {
  const tokens = (text.toLowerCase().match(WORD_RUN) ?? []).flatMap((run) =>
    splitRun(run, lookup),
  );
  const english = tokens.filter((token) => ASCII_WORD.test(token));
  const stems = stemWords(english);
  let i = 0;
  return tokens.map((token) => (ASCII_WORD.test(token) ? stems[i++] : token));
}

/** Same analysis for indexed fields and queries; exact identifiers bypass it. */
export function lexicalTokens(text: string): string[] {
  return tokenize(text, glossary);
}

/**
 * Adopt the glossary an index was built with. The query side reads it from the
 * index rather than the project config so a config edit that has not been
 * re-indexed cannot tokenize a query differently from the passages it searches.
 */
export async function adoptIndexedSegmenterWords(db: SearchDb): Promise<void> {
  const stored = (
    await db.execute({
      sql: 'SELECT value FROM meta WHERE key=?',
      args: [SEGMENTER_WORDS_KEY],
    })
  ).rows[0]?.value;
  setSegmenterWords(parseStoredWords(stored));
}

/**
 * Glossary recorded in an index's metadata. A reader validates against this
 * rather than the project config: a deployed site serves a built artifact with
 * no config file next to it, and the index is what its tokens actually came
 * from.
 */
export function parseStoredWords(stored: string | undefined): string[] {
  if (!stored) return [];
  try {
    const words: unknown = JSON.parse(stored);
    return Array.isArray(words)
      ? words.filter((word): word is string => typeof word === 'string')
      : [];
  } catch {
    // A malformed row is not worth failing a search over; the version check
    // that guards the index will force a rebuild anyway.
    return [];
  }
}

/** Populate derived lexical rows, reusing original passages and vectors. */
export async function synchronizeLexical(
  db: SearchDb,
  words: readonly string[] = [],
): Promise<void> {
  // Tokenize from a private lookup rather than adopting `words` as module
  // state: the row loop awaits between rows, so a query adopting its own
  // glossary mid-loop would otherwise tokenize the remaining rows with the
  // wrong dictionary and leave `meta` describing a mixture nothing can detect.
  const lookup = indexGlossary(words);
  const version = lexicalVersion(words);
  const wordsJson = JSON.stringify(words);
  // One read for both rows: the glossary is written back only when it actually
  // differs, so a no-op synchronization leaves the published file untouched.
  const stored = new Map(
    (
      await db.execute(
        "SELECT key,value FROM meta WHERE key IN ('lexical_version','segmenter_words')",
      )
    ).rows.map((row) => [row.key as string, row.value as string]),
  );
  const versionChanged = stored.get('lexical_version') !== version;
  if (versionChanged) {
    await db.execute('DROP INDEX IF EXISTS chunks_fts');
    await db.execute('DELETE FROM lexical_chunks');
  }
  await db.execute(
    'DELETE FROM lexical_chunks WHERE id NOT IN (SELECT id FROM chunks)',
  );
  const rows = (
    await db.execute(
      'SELECT id,body,heading,path FROM chunks WHERE id NOT IN (SELECT id FROM lexical_chunks)',
    )
  ).rows;
  await ensureSegmenterFor(
    rows.flatMap((row) => [row.body, row.heading, row.path]),
  );
  for (const row of rows)
    await db.execute({
      sql: 'INSERT INTO lexical_chunks VALUES (?,?,?,?)',
      args: [
        row.id,
        ...[row.body, row.heading, row.path].map((text) =>
          tokenize(text, lookup).join(' '),
        ),
      ],
    });
  if (versionChanged) {
    await db.execute(CREATE_PASSAGE_FTS);
    await db.execute({
      sql: 'INSERT OR REPLACE INTO meta VALUES (?,?)',
      args: ['lexical_version', version],
    });
  }
  if ((stored.get(SEGMENTER_WORDS_KEY) ?? '[]') !== wordsJson)
    await db.execute({
      sql: 'INSERT OR REPLACE INTO meta VALUES (?,?)',
      args: [SEGMENTER_WORDS_KEY, wordsJson],
    });
}
