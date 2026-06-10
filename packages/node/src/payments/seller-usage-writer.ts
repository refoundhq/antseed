import type { SerializedHttpRequest } from '../types/http.js';
import type { parseResponseUsage } from '../utils/response-usage.js';
import {
  buildUsageManifestRecord,
  publishUsageManifestBestEffort,
  type UsageManifestStore,
} from './usage-manifest.js';

export interface SellerUsageWriteInput {
  channelId: string;
  request: SerializedHttpRequest;
  responseBody: Uint8Array;
  service?: string;
  costUsdc: bigint;
  cumulativeSpend: bigint;
  usage: ReturnType<typeof parseResponseUsage>;
}

export interface SellerUsagePointer {
  cid: string;
  usageRoot: string;
}

export class SellerUsageWriter {
  constructor(private readonly _store: UsageManifestStore | null = null) {}

  write(input: SellerUsageWriteInput): SellerUsagePointer | null {
    if (!this._store) return null;
    const record = buildUsageManifestRecord({
      requestId: input.request.requestId,
      service: input.service,
      costUsdc: input.costUsdc,
      cumulativeCostUsdc: input.cumulativeSpend,
      inputTokens: input.usage.inputTokens,
      cachedInputTokens: input.usage.cachedInputTokens,
      freshInputTokens: input.usage.freshInputTokens,
      outputTokens: input.usage.outputTokens,
      inputBody: input.request.body,
      outputBody: input.responseBody,
    });
    const pointer = this._store.append(input.channelId, record);
    publishUsageManifestBestEffort(pointer);
    return { cid: pointer.cid, usageRoot: pointer.usageRoot };
  }
}
