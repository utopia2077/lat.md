---
lat:
  require-code-mention: true
---

# Remote Embedder

Tests verify provider selection for OpenAI-compatible endpoints, vector-width probing, and rate-limit handling against a local HTTP server.

## Provider selection

An explicit `baseUrl` and `model` replace key-prefix detection, and every shape that cannot be served is rejected before any request is made.

### Selects an explicit OpenAI-compatible endpoint

A configured endpoint overrides prefix detection, so an `sk-` key issued by a gateway such as SiliconFlow is not sent to OpenAI, and its vector width is left to be probed.

### Rejects an unusable endpoint selection

A missing model, an empty or unparsable base URL, and plain `http` outside loopback are rejected with a message naming the rule, and an unrecognized key prefix points at the endpoint variables as the escape hatch.

## Custom endpoint embedding

A custom endpoint is treated as an unknown model until its width is learned, after which it behaves like any other hosted backend.

### Probes the vector width on first use

The backend makes one throwaway request to learn the width and reports it as the model key, but skips the probe when the width is already known, so a query does not pay for it.

## Rate limiting

A provider that limits tokens per minute answers `429`, which the backend waits out rather than failing the run.

### Waits out a 429 and continues the queue

The backend waits and retries the same batch, reports the wait so a long pause is not mistaken for a hang, and prefers a server-supplied `Retry-After` over its configured fallback.

### Fails with the batch escape hatch after exhausting retries

Once the retry budget is spent the failure names the batch-token bound, because a single batch that exceeds the limit on its own never succeeds by waiting.
