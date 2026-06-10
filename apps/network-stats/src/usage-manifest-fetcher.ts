import { createHash } from 'node:crypto';
import type { UsageManifest } from '@antseed/node';

export interface UsageManifestFetcherOptions {
  gatewayUrl?: string;
}

export class UsageManifestFetcher {
  private readonly _gatewayUrl: string;

  constructor(options: UsageManifestFetcherOptions = {}) {
    this._gatewayUrl = options.gatewayUrl ?? process.env['NETWORK_STATS_IPFS_GATEWAY_URL'] ?? 'https://ipfs.io/ipfs';
  }

  async fetch(cid: string, expectedRoot: string): Promise<UsageManifest> {
    const res = await fetch(`${this._gatewayUrl.replace(/\/$/, '')}/${encodeURIComponent(cid)}`);
    if (!res.ok) {
      throw new Error(`failed to fetch usage manifest ${cid}: HTTP ${res.status}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const root = `0x${createHash('sha256').update(bytes).digest('hex')}`;
    if (root.toLowerCase() !== expectedRoot.toLowerCase()) {
      throw new Error(`usage manifest root mismatch for ${cid}`);
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as UsageManifest;
  }
}
