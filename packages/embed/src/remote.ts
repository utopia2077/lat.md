/**
 * Remote embedding backend: OpenAI-compatible `/v1/embeddings` over `fetch`.
 *
 * Provider selection starts from the key prefix, but any OpenAI-compatible
 * endpoint can be selected explicitly with a `baseUrl` and `model`. That
 * override matters for gateways such as SiliconFlow, which issue `sk-`-prefixed
 * keys that prefix detection would otherwise route to OpenAI itself.
 */

import type { Embedder } from './index.js';
import { getEncoding } from 'js-tiktoken';

let tokenizer: ReturnType<typeof getEncoding> | undefined;
const encoding = () => (tokenizer ??= getEncoding('cl100k_base'));
const MAX_INPUT_TOKENS = 8191;
const MAX_BATCH_TOKENS = 250000;
const MAX_BATCH = 2048;

/**
 * A provider that rate-limits by tokens per minute rejects a batch that is
 * simply too large, however long we wait. Lowering these bounds is the escape
 * hatch; they are read per call so a test or a one-off run can set them.
 */
function batchLimits(): { maxTokens: number; maxItems: number } {
  const positive = (value: string | undefined): number | null => {
    if (!value) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
  };
  return {
    maxTokens:
      positive(process.env.LAT_EMBED_BATCH_TOKENS) ?? MAX_BATCH_TOKENS,
    maxItems: positive(process.env.LAT_EMBED_BATCH) ?? MAX_BATCH,
  };
}

/** Retries for a 429 — the one failure the provider asks us to retry. */
const MAX_RATE_LIMIT_RETRIES = 5;
/** Fallback wait when a 429 carries no `Retry-After`; limits reset per minute. */
const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000;
const MIN_RATE_LIMIT_WAIT_MS = 1_000;
const MAX_RATE_LIMIT_WAIT_MS = 10 * 60_000;

function positiveEnvInt(name: string): number | null {
  const value = process.env[name];
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

/** Retry policy, read per call so a long reindex can be tuned without a rebuild. */
export function rateLimitPolicy(): { attempts: number; waitMs: number } {
  return {
    attempts:
      positiveEnvInt('LAT_EMBED_RATE_LIMIT_RETRIES') ?? MAX_RATE_LIMIT_RETRIES,
    waitMs:
      positiveEnvInt('LAT_EMBED_RATE_LIMIT_WAIT_MS') ??
      DEFAULT_RATE_LIMIT_WAIT_MS,
  };
}

export type RemoteProvider = {
  name: string;
  apiBase: string;
  model: string;
  /** Known width for a built-in provider; probed on first use when absent. */
  dimensions?: number;
  /**
   * Set only when the endpoint itself identifies the vectors, so the index
   * fingerprint must cover it. A built-in provider's apiBase is a constant, and
   * folding it in would change the fingerprint and force every existing hosted
   * index to be re-embedded for no benefit.
   */
  endpointIsIdentity?: boolean;
  headers: (key: string) => Record<string, string>;
};

/** Thrown when the provider rejects the credential (HTTP 401/403). */
export class EmbeddingAuthError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`Embedding API rejected the key (${status}): ${body.slice(0, 200)}`);
    this.name = 'EmbeddingAuthError';
    this.status = status;
  }
}

/** Thrown when a 429 outlives every retry. */
export class EmbeddingRateLimitError extends Error {
  constructor(attempts: number, lastBody: string) {
    super(
      `Embedding API is still rate-limiting after ${attempts} waits (${lastBody.slice(0, 200)}). ` +
        `If a single batch exceeds the provider's tokens-per-minute limit, lower ` +
        `LAT_EMBED_BATCH_TOKENS (currently ${batchLimits().maxTokens}).`,
    );
    this.name = 'EmbeddingRateLimitError';
  }
}

const openai: RemoteProvider = {
  name: 'openai',
  apiBase: 'https://api.openai.com/v1',
  model: 'text-embedding-3-small',
  dimensions: 1536,
  headers: (key) => ({
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  }),
};

const vercel: RemoteProvider = {
  name: 'vercel',
  apiBase: 'https://ai-gateway.vercel.sh/v1',
  model: 'openai/text-embedding-3-small',
  dimensions: 1536,
  headers: (key) => ({
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  }),
};

const bearerHeaders = (key: string) => ({
  Authorization: `Bearer ${key}`,
  'Content-Type': 'application/json',
});

export type RemoteSelection = {
  /** Explicit OpenAI-compatible endpoint; overrides key-prefix detection. */
  baseUrl?: string;
  /** Model id sent to the endpoint; required with `baseUrl`. */
  model?: string;
};

/** Map a key (and any explicit selection) to a provider. */
export function detectProvider(
  key: string,
  selection: RemoteSelection = {},
): RemoteProvider {
  if (selection.baseUrl !== undefined) {
    const baseUrl = selection.baseUrl.trim();
    const model = selection.model?.trim();
    if (!baseUrl) throw new Error('Embedding base URL must not be empty.');
    if (!model)
      throw new Error(
        'An embedding base URL requires a model id — set LAT_LLM_MODEL (or the model in the repo config).',
      );
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error(`Embedding base URL is not a valid URL: ${baseUrl}`);
    }
    // Plain http is accepted only on loopback: a local embedding server
    // (Ollama, LM Studio, vLLM) is reachable nowhere else, so the transport
    // cannot leak the credential the way a remote http endpoint could.
    const loopback =
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '[::1]' ||
      parsed.hostname === '::1';
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback))
      throw new Error(`Embedding base URL must use https: ${baseUrl}`);
    return {
      name: `custom:${model}`,
      apiBase: baseUrl.replace(/\/+$/, ''),
      model,
      // Unknown width: gateways serve many models with different dimensions.
      endpointIsIdentity: true,
      headers: bearerHeaders,
    };
  }

  if (key.startsWith('REPLAY_LAT_LLM_KEY::')) {
    const replayUrl = key.slice('REPLAY_LAT_LLM_KEY::'.length);
    return {
      name: 'replay',
      apiBase: replayUrl,
      model: 'replay',
      dimensions: 1536,
      headers: () => ({ 'Content-Type': 'application/json' }),
    };
  }
  if (key.startsWith('sk-ant-')) {
    throw new Error(
      "Anthropic doesn't offer an embedding model. Set LAT_LLM_KEY to an OpenAI (sk-...) or Vercel AI Gateway (vck_...) key.",
    );
  }
  if (key.startsWith('vck_')) return vercel;
  if (key.startsWith('sk-')) return openai;
  throw new Error(
    `Unrecognized LAT_LLM_KEY prefix. Supported: OpenAI (sk-...), Vercel AI Gateway (vck_...). Use LAT_LLM_BASE_URL and LAT_LLM_MODEL for any other OpenAI-compatible endpoint.`,
  );
}

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into milliseconds. */
export function retryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : date - Date.now();
}

function waitForRateLimit(
  header: string | null,
  attempt: number,
  policy: { attempts: number; waitMs: number },
  onNotice: (message: string) => void,
): Promise<void> {
  // A server-supplied delay is clamped so a hostile or mistaken header cannot
  // stall a run; a configured fallback is used exactly as given.
  const fromHeader = retryAfterMs(header);
  const waitMs =
    fromHeader === null
      ? policy.waitMs
      : Math.min(MAX_RATE_LIMIT_WAIT_MS, Math.max(MIN_RATE_LIMIT_WAIT_MS, fromHeader));
  onNotice(
    `Embedding provider is rate-limiting; waiting ${Math.round(waitMs / 1000)}s before retry ${attempt}/${policy.attempts}.`,
  );
  return new Promise((resolve) => setTimeout(resolve, waitMs));
}

async function embedViaFetch(
  texts: string[],
  provider: RemoteProvider,
  key: string,
  onProgress?: (done: number, total: number) => void,
  onNotice?: (message: string) => void,
): Promise<number[][]> {
  const { maxTokens, maxItems } = batchLimits();
  const notice =
    onNotice ??
    ((message: string) => process.stderr.write(`${message}\n`));
  const results: number[][] = [];
  for (let i = 0; i < texts.length; ) {
    const batch: string[] = [];
    let tokens = 0;
    while (i < texts.length && batch.length < maxItems) {
      const count = encoding().encode(texts[i], [], []).length;
      if (count > MAX_INPUT_TOKENS)
        throw new Error('Embedding input exceeds model token limit');
      if (batch.length && tokens + count > maxTokens) break;
      tokens += count;
      batch.push(texts[i++]);
    }

    const policy = rateLimitPolicy();
    let response: Response;
    for (let attempt = 1; ; attempt++) {
      response = await fetch(`${provider.apiBase}/embeddings`, {
        method: 'POST',
        headers: provider.headers(key),
        body: JSON.stringify({ model: provider.model, input: batch }),
      });
      if (response.status !== 429) break;
      if (attempt > policy.attempts)
        throw new EmbeddingRateLimitError(
          attempt - 1,
          await response.text().catch(() => ''),
        );
      await waitForRateLimit(
        response.headers.get('retry-after'),
        attempt,
        policy,
        notice,
      );
    }

    if (!response.ok) {
      const body = await response.text();
      if (response.status === 401 || response.status === 403) {
        throw new EmbeddingAuthError(response.status, body);
      }
      throw new Error(
        `Embedding API error (${response.status}): ${body.slice(0, 200)}`,
      );
    }
    const json = (await response.json()) as {
      data: { embedding: number[]; index: number }[];
    };
    const sorted = json.data.sort((a, b) => a.index - b.index);
    for (const item of sorted) results.push(item.embedding);
    onProgress?.(i, texts.length);
  }
  return results;
}

export type RemoteEmbedderOptions = RemoteSelection & {
  /** Known vector width, e.g. parsed from the index's recorded model. */
  dimensions?: number;
};

export async function createRemoteEmbedder(
  key: string,
  options: RemoteEmbedderOptions = {},
): Promise<Embedder> {
  const provider = detectProvider(key, options);
  const dimensions =
    options.dimensions ??
    provider.dimensions ??
    (await probeDimensions(provider, key));
  return {
    name: provider.name,
    dimensions,
    maxInputTokens: MAX_INPUT_TOKENS,
    // A custom endpoint participates in the index fingerprint: pointing the
    // same model name at a different gateway must force a reindex rather than
    // silently mixing vectors from two services. Built-in providers keep the
    // bare fingerprint, so upgrading does not invalidate their indexes.
    tokenizerFingerprint: provider.endpointIsIdentity
      ? `cl100k_base:v1@${provider.apiBase}`
      : 'cl100k_base:v1',
    countTokens: (text) => encoding().encode(text, [], []).length,
    embed: (texts, onProgress, onNotice) =>
      texts.length
        ? embedViaFetch(texts, provider, key, onProgress, onNotice)
        : Promise.resolve([]),
  };
}

/** One throwaway request to learn an endpoint's vector width. */
async function probeDimensions(
  provider: RemoteProvider,
  key: string,
): Promise<number> {
  const [vector] = await embedViaFetch(['lat'], provider, key);
  if (!vector?.length)
    throw new Error(
      `Embedding endpoint ${provider.apiBase} returned no vector for model ${provider.model}.`,
    );
  return vector.length;
}
