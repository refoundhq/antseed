import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { UsageManifestFetcher } from './usage-manifest-fetcher.js';

const enc = new TextEncoder();

function manifestBytes(): Uint8Array {
  return enc.encode(JSON.stringify({
    version: 1,
    channelId: '0x' + '1'.repeat(64),
    records: [],
    totals: {
      costUsdc: '0',
      inputTokens: '0',
      cachedInputTokens: '0',
      freshInputTokens: '0',
      outputTokens: '0',
      requestCount: '0',
    },
    services: {},
  }));
}

function sha256Root(bytes: Uint8Array): string {
  return `0x${createHash('sha256').update(bytes).digest('hex')}`;
}

describe('UsageManifestFetcher', () => {
  const originalFetch = globalThis.fetch;

  it('fetches and verifies a bounded usage manifest', async () => {
    const bytes = manifestBytes();
    globalThis.fetch = async () => new Response(bytes, { status: 200 });
    try {
      const fetcher = new UsageManifestFetcher({
        gatewayUrl: 'https://example.test/ipfs',
        maxBytes: bytes.byteLength,
      });
      const manifest = await fetcher.fetch('bafkreitest', sha256Root(bytes));
      assert.equal(manifest.version, 1);
      assert.equal(manifest.channelId, '0x' + '1'.repeat(64));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects streamed usage manifests that exceed the byte limit', async () => {
    globalThis.fetch = async () => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(4));
          controller.enqueue(new Uint8Array(4));
          controller.close();
        },
      }),
      { status: 200 },
    );
    try {
      const fetcher = new UsageManifestFetcher({ maxBytes: 5 });
      await assert.rejects(
        () => fetcher.fetch('bafkreitest', '0x' + '0'.repeat(64)),
        /exceeds max size/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('aborts usage manifest fetches after the configured timeout', async () => {
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      });
    })) as typeof fetch;
    try {
      const fetcher = new UsageManifestFetcher({ timeoutMs: 1 });
      await assert.rejects(
        () => fetcher.fetch('bafkreitest', '0x' + '0'.repeat(64)),
        /timed out/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
