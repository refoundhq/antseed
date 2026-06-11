import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ZERO_USAGE_ROOT } from '@antseed/node';

import { UsageManifestFetcher } from './usage-manifest-fetcher.js';

const enc = new TextEncoder();

function batchBytes(): Uint8Array {
  return enc.encode(JSON.stringify({
    version: 1,
    prevRoot: ZERO_USAGE_ROOT,
    usageRoot: ZERO_USAGE_ROOT,
    leaves: [],
  }));
}

describe('UsageManifestFetcher', () => {
  const originalFetch = globalThis.fetch;

  it('fetches and verifies a bounded usage leaf batch', async () => {
    const bytes = batchBytes();
    globalThis.fetch = async () => new Response(bytes, { status: 200 });
    try {
      const fetcher = new UsageManifestFetcher({
        gatewayUrl: 'https://example.test/ipfs',
        maxBytes: bytes.byteLength,
      });
      const batch = await fetcher.fetch('bafkreitest', ZERO_USAGE_ROOT);
      assert.equal(batch.version, 1);
      assert.equal(batch.usageRoot, ZERO_USAGE_ROOT);
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
