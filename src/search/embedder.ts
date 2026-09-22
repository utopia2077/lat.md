import {
  createEmbedder,
  EmbeddingAuthError,
  type Embedder,
} from '@lat.md/embed';
import minilm from '@lat.md/embed-minilm-fp16';
import {
  getLlmKey,
  getRemoteSelection,
  getRepoEmbedding,
} from '@lat.md/core/config';

export type { Embedder };
export { EmbeddingAuthError };

/** Explicit OpenAI-compatible endpoint selection for a repo, if any. */
export type SearchEngineOptions = {
  baseUrl?: string;
  model?: string;
  dimensions?: number;
};

export type CreateSearchEngine = (
  key?: string,
  options?: SearchEngineOptions,
) => Promise<Embedder>;

const defaultCreateSearchEngine: CreateSearchEngine = (key, options) =>
  key
    ? createEmbedder({
        key,
        baseUrl: options?.baseUrl,
        modelId: options?.model,
        dimensions: options?.dimensions,
      })
    : createEmbedder({ model: minilm });

/** `meta.embedding_model` value for an embedder, e.g. `local:minilm-l6-v2:384`. */
export function modelKey(embedder: Embedder): string {
  return `${embedder.name}:${embedder.dimensions}`;
}

/**
 * Vector width recorded in a model key, e.g. `384` for `local:minilm-l6-v2:384`.
 * Reusing it avoids a probe request on every `lat search`; it is only trusted
 * when the model id still matches, since a different model has its own width.
 */
export function dimensionsFromModelKey(
  storedModel: string,
): number | undefined {
  const tail = storedModel.slice(storedModel.lastIndexOf(':') + 1);
  const parsed = Number(tail);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Model id inside a `custom:<model>:<dimensions>` key, if it is one. */
function customModelFromKey(storedModel: string): string | undefined {
  if (!storedModel.startsWith('custom:')) return undefined;
  const withoutPrefix = storedModel.slice('custom:'.length);
  const lastColon = withoutPrefix.lastIndexOf(':');
  return lastColon === -1 ? withoutPrefix : withoutPrefix.slice(0, lastColon);
}

/** Selection recorded for a repo, paired with dimensions we can justify reusing. */
function selectionFor(
  latDir: string | undefined,
  storedModel: string | null,
): SearchEngineOptions {
  const { baseUrl, model } = getRemoteSelection(latDir);
  const storedModelId = storedModel
    ? customModelFromKey(storedModel)
    : undefined;
  const dimensions =
    storedModel && storedModelId !== undefined && storedModelId === model
      ? dimensionsFromModelKey(storedModel)
      : undefined;
  return { baseUrl, model, dimensions };
}

/** Thrown when the stored index can't be served by the current environment and
 *  a `lat reindex` is required (wrong/absent key, or model mismatch). */
export class ReindexRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReindexRequiredError';
  }
}

/** Build an embedder from the environment (key → remote, else local). Used for
 *  a fresh index and by `lat reindex` when re-deciding the backend. */
export async function embedderFromEnv(
  latDir?: string,
  createSearchEngine: CreateSearchEngine = defaultCreateSearchEngine,
  /** Recorded model of an existing index, so its vector width can be reused. */
  storedModel: string | null = null,
): Promise<Embedder> {
  const key = getLlmKey();
  return key
    ? createSearchEngine(key, selectionFor(latDir, storedModel))
    : createSearchEngine();
}

/** Local (offline) embedder, ignoring any configured key. */
export function localEmbedder(): Promise<Embedder> {
  return createEmbedder({ model: minilm });
}

/**
 * Resolve the embedder `lat search` must use, given the index's recorded model
 * and the repo dir. The stored model is authoritative — the env var never
 * silently flips the backend. A local index ignores the key; a remote index
 * requires a matching key (used to embed every query) or throws
 * {@link ReindexRequiredError}. On a fresh index (no stored model — e.g. the
 * regenerable `.cache` was wiped) the durable per-repo preference wins over the
 * env, so a repo switched to local stays local across cache loss.
 */
export async function embedderForIndex(
  storedModel: string | null,
  latDir: string,
  createSearchEngine: CreateSearchEngine = defaultCreateSearchEngine,
): Promise<Embedder> {
  if (storedModel === null) {
    if (getRepoEmbedding(latDir) === 'local') return createSearchEngine();
    // No durable preference — decide from the environment, record it later.
    return embedderFromEnv(latDir, createSearchEngine);
  }

  if (storedModel.startsWith('local:')) {
    return createSearchEngine(); // ignores LAT_LLM_KEY entirely
  }

  // Remote-pinned index: needs a key that resolves to the same model.
  const key = getLlmKey();
  if (!key) {
    throw new ReindexRequiredError(
      `This index was built with '${storedModel}', but no LAT_LLM_KEY is set. ` +
        `Run 'lat reindex' to switch to the local model or restore the key.`,
    );
  }
  const embedder = await createSearchEngine(
    key,
    selectionFor(latDir, storedModel),
  );
  if (modelKey(embedder) !== storedModel) {
    throw new ReindexRequiredError(
      `This index was built with '${storedModel}', but the current key resolves ` +
        `to '${modelKey(embedder)}'. Run 'lat reindex' to rebuild.`,
    );
  }
  return embedder;
}
