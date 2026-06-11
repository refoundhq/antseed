import { keccak256 } from 'ethers';
import type { PeerId } from '../types/peer.js';
import {
  buildUsageLeafBatch,
  buildUsageManifestRecord,
  computeUsageLeafBatchPointer,
  type UsageLeaf,
  type UsageLeafBatch,
  type UsageManifestStore,
} from './usage-manifest.js';
import { encodePointerMetadata } from './evm/signatures.js';

export interface UsageObservationInput {
  requestId: string;
  service?: string;
  costUsdc: bigint;
  cumulativeCostUsdc: bigint;
  inputTokens: number;
  cachedInputTokens: number;
  freshInputTokens: number;
  outputTokens: number;
  inputBody: Uint8Array;
  outputBody: Uint8Array;
}

export interface PendingUsageBatch {
  batch: UsageLeafBatch;
  encodedMetadata: string;
  metadataHash: string;
  usageRoot: string;
  usageCid: string;
  leaves: UsageLeaf[];
}

export class BuyerUsageVerifier {
  private readonly _pendingLeavesByPeer = new Map<string, UsageLeaf[]>();
  private readonly _usageRootsByChannel = new Map<string, string>();

  constructor(private readonly _store: UsageManifestStore | null = null) {}

  get pendingObservationCount(): number {
    let count = 0;
    for (const leaves of this._pendingLeavesByPeer.values()) count += leaves.length;
    return count;
  }

  recordObservation(peerId: PeerId, observation: UsageObservationInput): void {
    const leaf = buildUsageManifestRecord({
      requestId: observation.requestId,
      service: observation.service,
      costUsdc: observation.costUsdc,
      cumulativeCostUsdc: observation.cumulativeCostUsdc,
      inputTokens: observation.inputTokens,
      cachedInputTokens: observation.cachedInputTokens,
      freshInputTokens: observation.freshInputTokens,
      outputTokens: observation.outputTokens,
      inputBody: observation.inputBody,
      outputBody: observation.outputBody,
    });
    const pending = this._pendingLeavesByPeer.get(peerId) ?? [];
    pending.push(leaf);
    this._pendingLeavesByPeer.set(peerId, pending);
  }

  buildPendingBatch(peerId: PeerId, channelId: string): PendingUsageBatch | null {
    const leaves = this._pendingLeavesByPeer.get(peerId);
    if (!leaves || leaves.length === 0) return null;
    const prevRoot = this._getUsageRoot(channelId);
    const batch = buildUsageLeafBatch(prevRoot, leaves);
    const pointer = computeUsageLeafBatchPointer(batch);
    const encodedMetadata = encodePointerMetadata(pointer.cid, pointer.usageRoot);
    return {
      batch,
      encodedMetadata,
      metadataHash: keccak256(encodedMetadata),
      usageRoot: pointer.usageRoot,
      usageCid: pointer.cid,
      leaves: [...leaves],
    };
  }

  commitBatch(peerId: PeerId, channelId: string, batch: UsageLeafBatch): void {
    this._store?.appendLeafBatch(channelId, batch);
    this._usageRootsByChannel.set(channelId, batch.usageRoot);
    const pending = this._pendingLeavesByPeer.get(peerId) ?? [];
    const remaining = pending.slice(batch.leaves.length);
    if (remaining.length > 0) this._pendingLeavesByPeer.set(peerId, remaining);
    else this._pendingLeavesByPeer.delete(peerId);
  }

  getCommittedCumulativeCost(channelId: string): bigint {
    const records = this._store?.getRecords(channelId) ?? [];
    const last = records.at(-1);
    return last ? BigInt(last.cumulativeCostUsdc) : 0n;
  }

  clearPeer(peerId: PeerId): void {
    this._pendingLeavesByPeer.delete(peerId);
  }

  cleanup(): void {
    this._pendingLeavesByPeer.clear();
    this._usageRootsByChannel.clear();
  }

  private _getUsageRoot(channelId: string): string {
    const existing = this._usageRootsByChannel.get(channelId);
    if (existing) return existing;
    const root = this._store?.getUsageRoot(channelId) ?? `0x${'00'.repeat(32)}`;
    this._usageRootsByChannel.set(channelId, root);
    return root;
  }
}
