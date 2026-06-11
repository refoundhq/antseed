import { keccak256 } from 'ethers';
import type { SerializedHttpRequest } from '../types/http.js';
import type { SpendingAuthPayload } from '../types/protocol.js';
import type { parseResponseUsage } from '../utils/response-usage.js';
import {
  buildUsageLeafBatch,
  buildUsageManifestRecord,
  computeUsageLeafBatchPointer,
  publishUsageManifestBestEffort,
  publishUsageLeafBatchBestEffort,
  type UsageLeaf,
  type UsageManifestStore,
} from './usage-manifest.js';
import { encodePointerMetadata } from './evm/signatures.js';

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

interface PendingSellerUsage {
  expected: UsageLeaf;
  minCostUsdc: bigint;
}

export class SellerUsageWriter {
  private readonly _pendingByChannel = new Map<string, Map<string, PendingSellerUsage>>();

  constructor(private readonly _store: UsageManifestStore | null = null) {}

  recordObservation(input: SellerUsageWriteInput): void {
    const record = this._buildRecord(input);
    const channel = this._pendingByChannel.get(input.channelId) ?? new Map<string, PendingSellerUsage>();
    channel.set(input.request.requestId, {
      expected: record,
      minCostUsdc: input.costUsdc,
    });
    this._pendingByChannel.set(input.channelId, channel);
  }

  acceptSignedBatch(
    channelId: string,
    payload: SpendingAuthPayload,
    signedCumulativeAmount: bigint,
  ): SellerUsagePointer | null {
    if (!this._store) return null;
    if (!payload.usageLeaves || payload.usageLeaves.length === 0 || !payload.usageRoot || !payload.usageCid) {
      return null;
    }

    const pending = this._pendingByChannel.get(channelId);
    if (!pending) return null;

    for (const leaf of payload.usageLeaves) {
      const observed = pending.get(leaf.requestId);
      if (!observed || !this._leafMatchesObservation(leaf, observed, signedCumulativeAmount)) {
        return null;
      }
    }

    const prevRoot = this._store.getUsageRoot(channelId);
    const batch = buildUsageLeafBatch(prevRoot, payload.usageLeaves);
    const pointer = computeUsageLeafBatchPointer(batch);
    if (pointer.usageRoot.toLowerCase() !== payload.usageRoot.toLowerCase() || pointer.cid !== payload.usageCid) {
      return null;
    }
    const encodedMetadata = encodePointerMetadata(pointer.cid, pointer.usageRoot);
    if (encodedMetadata.toLowerCase() !== payload.metadata.toLowerCase()) {
      return null;
    }
    if (keccak256(encodedMetadata).toLowerCase() !== payload.metadataHash.toLowerCase()) {
      return null;
    }

    const stored = this._store.appendLeafBatch(channelId, batch);
    publishUsageLeafBatchBestEffort(stored);
    for (const leaf of payload.usageLeaves) pending.delete(leaf.requestId);
    if (pending.size === 0) this._pendingByChannel.delete(channelId);
    return { cid: pointer.cid, usageRoot: pointer.usageRoot };
  }

  write(input: SellerUsageWriteInput): SellerUsagePointer | null {
    if (!this._store) return null;
    const record = this._buildRecord(input);
    const pointer = this._store.append(input.channelId, record);
    publishUsageManifestBestEffort(pointer);
    return { cid: pointer.cid, usageRoot: pointer.usageRoot };
  }

  private _buildRecord(input: SellerUsageWriteInput): UsageLeaf {
    return buildUsageManifestRecord({
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
  }

  private _leafMatchesObservation(
    leaf: UsageLeaf,
    observed: PendingSellerUsage,
    signedCumulativeAmount: bigint,
  ): boolean {
    const expected = observed.expected;
    if (leaf.requestId !== expected.requestId) return false;
    if ((leaf.service ?? '') !== (expected.service ?? '')) return false;
    if (leaf.inputSha256.toLowerCase() !== expected.inputSha256.toLowerCase()) return false;
    if (leaf.outputSha256.toLowerCase() !== expected.outputSha256.toLowerCase()) return false;
    if (leaf.inputTokens !== expected.inputTokens) return false;
    if (leaf.cachedInputTokens !== expected.cachedInputTokens) return false;
    if (leaf.freshInputTokens !== expected.freshInputTokens) return false;
    if (leaf.outputTokens !== expected.outputTokens) return false;
    try {
      if (BigInt(leaf.costUsdc) < observed.minCostUsdc) return false;
      if (BigInt(leaf.cumulativeCostUsdc) > signedCumulativeAmount) return false;
    } catch {
      return false;
    }
    return true;
  }
}
