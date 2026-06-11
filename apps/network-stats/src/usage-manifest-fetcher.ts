import { createHash } from 'node:crypto';
import type { UsageManifest } from '@antseed/node';

export interface UsageManifestFetcherOptions {
  gatewayUrl?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

export class UsageManifestFetcher {
  private readonly _gatewayUrl: string;
  private readonly _timeoutMs: number;
  private readonly _maxBytes: number;

  constructor(options: UsageManifestFetcherOptions = {}) {
    this._gatewayUrl = options.gatewayUrl ?? process.env['NETWORK_STATS_IPFS_GATEWAY_URL'] ?? 'https://ipfs.io/ipfs';
    this._timeoutMs = options.timeoutMs ?? readPositiveIntEnv('NETWORK_STATS_IPFS_FETCH_TIMEOUT_MS') ?? 10_000;
    this._maxBytes = options.maxBytes ?? readPositiveIntEnv('NETWORK_STATS_USAGE_MANIFEST_MAX_BYTES') ?? 16 * 1024 * 1024;
  }

  async fetch(cid: string, expectedRoot: string): Promise<UsageManifest> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeoutMs);
    try {
      const res = await fetch(`${this._gatewayUrl.replace(/\/$/, '')}/${encodeURIComponent(cid)}`, {
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`failed to fetch usage manifest ${cid}: HTTP ${res.status}`);
      }
      const bytes = await this._readBoundedBody(res, cid);
      const root = `0x${createHash('sha256').update(bytes).digest('hex')}`;
      if (root.toLowerCase() !== expectedRoot.toLowerCase()) {
        throw new Error(`usage manifest root mismatch for ${cid}`);
      }
      return JSON.parse(new TextDecoder().decode(bytes)) as UsageManifest;
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`timed out fetching usage manifest ${cid}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private async _readBoundedBody(res: Response, cid: string): Promise<Uint8Array> {
    const contentLength = res.headers.get('content-length');
    if (contentLength) {
      const length = Number(contentLength);
      if (Number.isFinite(length) && length > this._maxBytes) {
        throw new Error(`usage manifest ${cid} exceeds max size ${this._maxBytes} bytes`);
      }
    }

    if (!res.body) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > this._maxBytes) {
        throw new Error(`usage manifest ${cid} exceeds max size ${this._maxBytes} bytes`);
      }
      return bytes;
    }

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this._maxBytes) {
        await reader.cancel();
        throw new Error(`usage manifest ${cid} exceeds max size ${this._maxBytes} bytes`);
      }
      chunks.push(value);
    }

    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
}

function readPositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
