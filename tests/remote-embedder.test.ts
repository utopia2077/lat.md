import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createEmbedder,
  detectProvider,
  EmbeddingRateLimitError,
  retryAfterMs,
} from '@lat.md/embed';

type Reply = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

/** OpenAI-compatible endpoint that replays a scripted list of replies. */
async function startEndpoint(replies: Reply[]): Promise<{
  url: string;
  requests: { model: string; input: string[] }[];
}> {
  const requests: { model: string; input: string[] }[] = [];
  let index = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
        model: string;
        input: string[];
      };
      requests.push(parsed);
      const reply = replies[Math.min(index++, replies.length - 1)];
      res.writeHead(reply.status, {
        'content-type': 'application/json',
        ...(reply.headers ?? {}),
      });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  servers.push(server);
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

const servers: Server[] = [];

function embeddingReply(dimensions = 4, count = 1): Reply {
  return {
    status: 200,
    body: {
      data: Array.from({ length: count }, (_, position) => ({
        index: position,
        embedding: Array.from({ length: dimensions }, () => 0.5),
      })),
    },
  };
}

beforeEach(() => {
  delete process.env.LAT_LLM_BASE_URL;
  delete process.env.LAT_LLM_MODEL;
  delete process.env.LAT_EMBED_BATCH;
  delete process.env.LAT_EMBED_BATCH_TOKENS;
  delete process.env.LAT_EMBED_RATE_LIMIT_RETRIES;
  delete process.env.LAT_EMBED_RATE_LIMIT_WAIT_MS;
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

describe('provider selection', () => {
  // @lat: [[tests/remote-embedder#Remote Embedder#Provider selection#Selects an explicit OpenAI-compatible endpoint]]
  it('selects an explicit endpoint instead of the key prefix', () => {
    // SiliconFlow also issues `sk-` keys, which prefix detection sends to OpenAI.
    const provider = detectProvider('sk-example', {
      baseUrl: 'https://api.siliconflow.cn/v1/',
      model: 'BAAI/bge-m3',
    });
    expect(provider.name).toBe('custom:BAAI/bge-m3');
    expect(provider.apiBase).toBe('https://api.siliconflow.cn/v1');
    expect(provider.model).toBe('BAAI/bge-m3');
    // Gateways serve models of differing widths, so the width is probed.
    expect(provider.dimensions).toBeUndefined();
  });

  it('keeps prefix detection when no endpoint is selected', () => {
    expect(detectProvider('sk-x').name).toBe('openai');
    expect(detectProvider('vck_x').name).toBe('vercel');
  });

  // @lat: [[tests/remote-embedder#Remote Embedder#Provider selection#Rejects an unusable endpoint selection]]
  it.each([
    ['a missing model', { baseUrl: 'https://x.example/v1' }, 'requires a model'],
    ['an empty base URL', { baseUrl: '   ' }, 'must not be empty'],
    ['a non-URL base', { baseUrl: 'not a url', model: 'm' }, 'not a valid URL'],
    [
      'a non-https base',
      { baseUrl: 'http://x.example/v1', model: 'm' },
      'must use https',
    ],
  ])('rejects %s', (_label, selection, message) => {
    expect(() => detectProvider('sk-x', selection)).toThrow(message);
  });

  it('points an unknown key prefix at the documented escape hatch', () => {
    expect(() => detectProvider('gsk_unknown')).toThrow(
      /LAT_LLM_BASE_URL and LAT_LLM_MODEL/,
    );
  });

  it('parses Retry-After as seconds or an HTTP date', () => {
    expect(retryAfterMs('30')).toBe(30_000);
    expect(retryAfterMs(' 5 ')).toBe(5_000);
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs('soon')).toBeNull();
    const inTenSeconds = new Date(Date.now() + 10_000).toUTCString();
    expect(retryAfterMs(inTenSeconds)).toBeGreaterThan(8_000);
    expect(retryAfterMs(inTenSeconds)).toBeLessThanOrEqual(10_000);
  });
});

describe('custom endpoint embedding', () => {
  // @lat: [[tests/remote-embedder#Remote Embedder#Custom endpoint embedding#Probes the vector width on first use]]
  it('probes the vector width and reports it as the model key', async () => {
    const endpoint = await startEndpoint([embeddingReply(1024)]);
    const embedder = await createEmbedder({
      key: 'sk-example',
      baseUrl: endpoint.url,
      modelId: 'BAAI/bge-m3',
    });
    expect(embedder.dimensions).toBe(1024);
    expect(`${embedder.name}:${embedder.dimensions}`).toBe(
      'custom:BAAI/bge-m3:1024',
    );
    // The probe is the only request so far.
    expect(endpoint.requests).toHaveLength(1);
    expect(endpoint.requests[0].model).toBe('BAAI/bge-m3');
  });

  it('skips the probe when the width is already known', async () => {
    const endpoint = await startEndpoint([embeddingReply(768)]);
    const embedder = await createEmbedder({
      key: 'sk-example',
      baseUrl: endpoint.url,
      modelId: 'm',
      dimensions: 768,
    });
    expect(embedder.dimensions).toBe(768);
    expect(endpoint.requests).toHaveLength(0);
  });

  it('sends the configured model id', async () => {
    const endpoint = await startEndpoint([embeddingReply(8)]);
    const embedder = await createEmbedder({
      key: 'sk-example',
      baseUrl: endpoint.url,
      modelId: 'netease-youdao/bce-embedding-base_v1',
    });
    await embedder.embed(['hello']);
    expect(endpoint.requests.map((request) => request.model)).toEqual([
      'netease-youdao/bce-embedding-base_v1',
      'netease-youdao/bce-embedding-base_v1',
    ]);
  });
});

describe('rate limiting', () => {
  // @lat: [[tests/remote-embedder#Remote Embedder#Rate limiting#Waits out a 429 and continues the queue]]
  it('waits out a 429 and continues the queue', async () => {
    process.env.LAT_EMBED_RATE_LIMIT_WAIT_MS = '10';
    const endpoint = await startEndpoint([
      { status: 429, body: { error: 'TPM limit reached' } },
      embeddingReply(4, 1),
    ]);
    const embedder = await createEmbedder({
      key: 'sk-example',
      baseUrl: endpoint.url,
      modelId: 'm',
      dimensions: 4,
    });

    const notices: string[] = [];
    const vectors = await embedder.embed(['a'], undefined, (message) =>
      notices.push(message),
    );

    expect(vectors).toHaveLength(1);
    expect(endpoint.requests).toHaveLength(2);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/rate-limiting.*retry 1\/5/);
  });

  it('honors Retry-After over the configured fallback', async () => {
    process.env.LAT_EMBED_RATE_LIMIT_WAIT_MS = '10';
    const endpoint = await startEndpoint([
      { status: 429, body: {}, headers: { 'retry-after': '1' } },
      embeddingReply(4, 1),
    ]);
    const embedder = await createEmbedder({
      key: 'sk-example',
      baseUrl: endpoint.url,
      modelId: 'm',
      dimensions: 4,
    });

    const notices: string[] = [];
    await embedder.embed(['a'], undefined, (message) => notices.push(message));
    // Clamped up to the one-second floor, not the ten-millisecond fallback.
    expect(notices[0]).toMatch(/waiting 1s/);
  });

  // @lat: [[tests/remote-embedder#Remote Embedder#Rate limiting#Fails with the batch escape hatch after exhausting retries]]
  it('fails with the batch escape hatch after exhausting retries', async () => {
    process.env.LAT_EMBED_RATE_LIMIT_WAIT_MS = '10';
    process.env.LAT_EMBED_RATE_LIMIT_RETRIES = '2';
    const endpoint = await startEndpoint([
      { status: 429, body: { error: 'TPM limit reached' } },
    ]);
    const embedder = await createEmbedder({
      key: 'sk-example',
      baseUrl: endpoint.url,
      modelId: 'm',
      dimensions: 4,
    });

    const failure = await embedder
      .embed(['a'], undefined, () => {})
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EmbeddingRateLimitError);
    // A batch that cannot fit a tokens-per-minute budget never succeeds by
    // waiting, so the message must name the knob that shrinks it.
    expect((failure as Error).message).toContain('LAT_EMBED_BATCH_TOKENS');
    expect(endpoint.requests).toHaveLength(3);
  });

  it('splits requests according to the batch budget', async () => {
    process.env.LAT_EMBED_BATCH = '2';
    const endpoint = await startEndpoint([embeddingReply(4, 2)]);
    const embedder = await createEmbedder({
      key: 'sk-example',
      baseUrl: endpoint.url,
      modelId: 'm',
      dimensions: 4,
    });
    await embedder.embed(['a', 'b', 'c', 'd', 'e'], undefined, () => {});
    expect(endpoint.requests.map((request) => request.input.length)).toEqual([
      2, 2, 1,
    ]);
  });
});
