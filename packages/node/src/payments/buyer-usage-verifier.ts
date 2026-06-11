import { keccak256 } from 'ethers';
import type { NeedAuthPayload } from '../types/protocol.js';
import type { PeerId } from '../types/peer.js';
import {
  buildUsageManifest,
  buildUsageManifestRecord,
  computeUsageManifestPointer,
  type UsageManifestStore,
  type UsageManifestRecord,
} from './usage-manifest.js';
import { encodePointerMetadata } from './evm/signatures.js';

export interface UsageObservationInput {
  requestId: string;
  service?: string;
  costUsdc: bigint;
  inputTokens: number;
  cachedInputTokens: number;
  freshInputTokens: number;
  outputTokens: number;
  inputBody: Uint8Array;
  outputBody: Uint8Array;
}

interface UsageObservation extends UsageObservationInput {}

export interface VerifiedUsagePointer {
  record: UsageManifestRecord;
  encodedMetadata: string;
  metadataHash: string;
  requiredCumulativeAmount: bigint;
}

export class BuyerUsageVerifier {
  private readonly _observations = new Map<string, UsageObservation>();
  private readonly _observationWaiters = new Map<string, Array<(value: UsageObservation | null) => void>>();
  private readonly _verifiedRecordsByChannel = new Map<string, UsageManifestRecord[]>();
  private readonly _divergedChannels = new Set<string>();

  constructor(private readonly _store: UsageManifestStore | null = null) {}

  get pendingObservationCount(): number {
    return this._observations.size;
  }

  recordObservation(peerId: PeerId, observation: UsageObservationInput): void {
    const key = this._observationKey(peerId, observation.requestId);
    this._observations.set(key, observation);
    const waiters = this._observationWaiters.get(key);
    if (!waiters) return;
    this._observationWaiters.delete(key);
    for (const resolve of waiters) resolve(observation);
  }

  async verifyPointer(peerId: PeerId, payload: NeedAuthPayload): Promise<VerifiedUsagePointer | null> {
    if (!payload.requestId || !payload.usageCid || !payload.usageRoot) return null;
    const key = this._observationKey(peerId, payload.requestId);
    const observation = await this._waitForObservation(key, 2_000);
    this._observations.delete(key);
    if (!observation) {
      this._markDiverged(payload.channelId);
      return null;
    }

    const requiredCumulativeAmount = BigInt(payload.requiredCumulativeAmount);
    const record = buildUsageManifestRecord({
      requestId: observation.requestId,
      service: observation.service,
      costUsdc: BigInt(payload.lastRequestCost ?? observation.costUsdc),
      cumulativeCostUsdc: requiredCumulativeAmount,
      inputTokens: observation.inputTokens,
      cachedInputTokens: observation.cachedInputTokens,
      freshInputTokens: observation.freshInputTokens,
      outputTokens: observation.outputTokens,
      inputBody: observation.inputBody,
      outputBody: observation.outputBody,
    });
    const previous = this._getVerifiedRecords(payload.channelId);
    const pointer = computeUsageManifestPointer(buildUsageManifest(payload.channelId, [...previous, record]));
    const rootMatches = pointer.usageRoot.toLowerCase() === payload.usageRoot.toLowerCase();
    const cidMatches = pointer.cid === payload.usageCid;
    if (!rootMatches || !cidMatches) {
      this._markDiverged(payload.channelId);
      return null;
    }

    const encodedMetadata = encodePointerMetadata(payload.usageCid, payload.usageRoot);
    return {
      record,
      encodedMetadata,
      metadataHash: keccak256(encodedMetadata),
      requiredCumulativeAmount,
    };
  }

  commit(channelId: string, record: UsageManifestRecord): void {
    const records = this._getVerifiedRecords(channelId);
    records.push(record);
    this._verifiedRecordsByChannel.set(channelId, records);
    this._store?.replace(channelId, records);
  }

  isChannelDiverged(channelId: string): boolean {
    return this._divergedChannels.has(channelId.toLowerCase());
  }

  clearPeer(peerId: PeerId): void {
    const prefix = `${peerId}:`;
    for (const key of this._observations.keys()) {
      if (key.startsWith(prefix)) this._observations.delete(key);
    }
    for (const [key, waiters] of this._observationWaiters) {
      if (!key.startsWith(prefix)) continue;
      this._observationWaiters.delete(key);
      for (const resolve of waiters) resolve(null);
    }
  }

  cleanup(): void {
    this._observations.clear();
    for (const waiters of this._observationWaiters.values()) {
      for (const resolve of waiters) resolve(null);
    }
    this._observationWaiters.clear();
    this._verifiedRecordsByChannel.clear();
    this._divergedChannels.clear();
  }

  private _getVerifiedRecords(channelId: string): UsageManifestRecord[] {
    const existing = this._verifiedRecordsByChannel.get(channelId);
    if (existing) return existing;
    const records = this._store?.getRecords(channelId) ?? [];
    this._verifiedRecordsByChannel.set(channelId, records);
    return records;
  }

  private async _waitForObservation(key: string, timeoutMs: number): Promise<UsageObservation | null> {
    const existing = this._observations.get(key);
    if (existing) return existing;
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        const waiters = this._observationWaiters.get(key)?.filter((entry) => entry !== wrapped);
        if (waiters && waiters.length > 0) this._observationWaiters.set(key, waiters);
        else this._observationWaiters.delete(key);
        resolve(null);
      }, timeoutMs);
      const wrapped = (value: UsageObservation | null): void => {
        clearTimeout(timer);
        resolve(value);
      };
      const waiters = this._observationWaiters.get(key) ?? [];
      waiters.push(wrapped);
      this._observationWaiters.set(key, waiters);
    });
  }

  private _observationKey(peerId: PeerId, requestId: string): string {
    return `${peerId}:${requestId}`;
  }

  private _markDiverged(channelId: string): void {
    this._divergedChannels.add(channelId.toLowerCase());
  }
}
