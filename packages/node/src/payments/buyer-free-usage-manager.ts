import { randomBytes } from 'node:crypto';
import type { Identity } from '../p2p/identity.js';
import type { PaymentMux } from '../p2p/payment-mux.js';
import type { PeerInfo } from '../types/peer.js';
import type { FreeUsageAckPayload, NeedFreeUsageAuthPayload } from '../types/protocol.js';
import type { SellerAddressResolver } from '../discovery/seller-address-resolver.js';
import { peerIdToAddress } from '../types/peer.js';
import { debugLog, debugWarn } from '../utils/debug.js';
import {
  computeFreeUsageChannelId,
  computeFreeUsageMetadataHash,
  encodeFreeUsageMetadata,
  makeFreeUsageDomain,
  signFreeUsageAuth,
  signFreeUsageOpen,
  type FreeUsageMetadata,
} from './evm/signatures.js';
import type { ChannelStore } from './channel-store.js';
import { advanceUsageMetadata, RequestServiceTracker } from './channel-usage-accounting.js';

export interface BuyerFreeUsageConfig {
  chainId: number;
  freeUsageContractAddress: string;
  defaultAuthDurationSecs: number;
}

interface FreeUsageSession {
  channelId: string;
  salt: string;
  deadline: number;
  sellerEvmAddr: string;
  cumulativeInputTokens: bigint;
  cumulativeOutputTokens: bigint;
  cumulativeRequestCount: bigint;
  latestSequence: bigint;
  services: FreeUsageMetadata['services'];
  openedAck: boolean;
  latestMetadata: FreeUsageMetadata;
}

export class BuyerFreeUsageManager {
  private readonly _identity: Identity;
  private readonly _config: BuyerFreeUsageConfig;
  private readonly _sellerAddressResolver?: SellerAddressResolver;
  private readonly _channelStore?: ChannelStore;
  private readonly _domain: ReturnType<typeof makeFreeUsageDomain>;
  private readonly _sessions = new Map<string, FreeUsageSession>();
  private readonly _requestService = new RequestServiceTracker();

  constructor(
    identity: Identity,
    config: BuyerFreeUsageConfig,
    sellerAddressResolver?: SellerAddressResolver,
    channelStore?: ChannelStore,
  ) {
    this._identity = identity;
    this._config = config;
    this._sellerAddressResolver = sellerAddressResolver;
    this._channelStore = channelStore;
    this._domain = makeFreeUsageDomain(config.chainId, config.freeUsageContractAddress);
    this._hydrateFromStore();
  }

  private _hydrateFromStore(): void {
    if (!this._channelStore) return;
    const activeChannels = this._channelStore.getActiveChannelsByBuyer('buyer', this._identity.wallet.address, 'free');
    for (const channel of activeChannels) {
      const metadata = this._channelStore.getChannelMetadata(channel);
      this._sessions.set(channel.peerId, {
        channelId: channel.sessionId,
        salt: '0x' + '00'.repeat(32),
        deadline: channel.deadline,
        sellerEvmAddr: channel.sellerEvmAddr,
        cumulativeInputTokens: metadata.cumulativeInputTokens,
        cumulativeOutputTokens: metadata.cumulativeOutputTokens,
        cumulativeRequestCount: metadata.cumulativeRequestCount,
        latestSequence: BigInt(channel.requestCount),
        services: metadata.services,
        openedAck: true,
        latestMetadata: metadata,
      });
    }
  }

  trackRequestService(requestId: string, service: string): void {
    this._requestService.track(requestId, service);
  }

  async prepareOpen(peer: PeerInfo, paymentMux: PaymentMux): Promise<void> {
    const existing = this._sessions.get(peer.peerId);
    const nowSec = Math.floor(Date.now() / 1000);
    if (existing && existing.deadline > nowSec + 30) return;

    const sellerEvmAddr = await this._resolveSellerAddr(peer);
    const salt = '0x' + randomBytes(32).toString('hex');
    const channelId = computeFreeUsageChannelId(this._identity.wallet.address, sellerEvmAddr, salt);
    const deadline = nowSec + this._config.defaultAuthDurationSecs;
    const openSig = await signFreeUsageOpen(this._identity.wallet, this._domain, {
      channelId,
      deadline: BigInt(deadline),
    });
    const metadata: FreeUsageMetadata = {
      cumulativeInputTokens: 0n,
      cumulativeOutputTokens: 0n,
      cumulativeRequestCount: 0n,
      services: [],
    };

    const session: FreeUsageSession = {
      channelId,
      salt,
      deadline,
      sellerEvmAddr,
      cumulativeInputTokens: 0n,
      cumulativeOutputTokens: 0n,
      cumulativeRequestCount: 0n,
      latestSequence: 0n,
      services: [],
      openedAck: false,
      latestMetadata: metadata,
    };
    this._sessions.set(peer.peerId, session);
    this._persistSession(peer.peerId, session, openSig, null, null);

    paymentMux.sendFreeUsageOpen({ channelId, salt, deadline, openSig });
    debugLog(`[BuyerFreeUsage] Open sent to ${peer.peerId.slice(0, 12)}... channel=${channelId.slice(0, 18)}...`);
  }

  handleAck(sellerPeerId: string, payload: FreeUsageAckPayload): void {
    const session = this._sessions.get(sellerPeerId);
    if (!session || session.channelId !== payload.channelId) return;
    session.openedAck = true;
    debugLog(
      `[BuyerFreeUsage] Ack from ${sellerPeerId.slice(0, 12)}... channel=${payload.channelId.slice(0, 18)}...` +
      `${payload.acceptedSequence ? ` sequence=${payload.acceptedSequence}` : ''}`,
    );
  }

  onPeerDisconnect(sellerPeerId: string): void {
    this._sessions.delete(sellerPeerId);
  }

  async handleNeedAuth(
    sellerPeerId: string,
    payload: NeedFreeUsageAuthPayload,
    paymentMux: PaymentMux,
  ): Promise<void> {
    const session = this._sessions.get(sellerPeerId);
    if (!session || session.channelId !== payload.channelId) {
      debugWarn(`[BuyerFreeUsage] NeedFreeUsageAuth for unknown channel ${payload.channelId.slice(0, 18)}...`);
      return;
    }

    const requiredSequence = BigInt(payload.requiredSequence);
    if (requiredSequence <= session.latestSequence) {
      return;
    }

    const inputTokens = BigInt(payload.inputTokens ?? '0');
    const outputTokens = BigInt(payload.outputTokens ?? '0');
    const attributedService = this._requestService.get(payload.requestId) ?? payload.service;

    const metadata = advanceUsageMetadata(session.latestMetadata, attributedService, {
      amount: 0n,
      inputTokens,
      cachedInputTokens: 0n,
      outputTokens,
      requests: 1n,
    });
    const metadataHash = computeFreeUsageMetadataHash(metadata);
    const encodedMetadata = encodeFreeUsageMetadata(metadata);
    const usageSig = await signFreeUsageAuth(this._identity.wallet, this._domain, {
      channelId: session.channelId,
      sequence: requiredSequence,
      metadataHash,
      deadline: BigInt(session.deadline),
    });

    paymentMux.sendFreeUsageAuth({
      channelId: session.channelId,
      cumulativeInputTokens: metadata.cumulativeInputTokens.toString(),
      cumulativeOutputTokens: metadata.cumulativeOutputTokens.toString(),
      sequence: requiredSequence.toString(),
      metadataHash,
      metadata: encodedMetadata,
      deadline: session.deadline,
      usageSig,
    });

    session.latestSequence = requiredSequence;
    session.cumulativeInputTokens = metadata.cumulativeInputTokens;
    session.cumulativeOutputTokens = metadata.cumulativeOutputTokens;
    session.cumulativeRequestCount = metadata.cumulativeRequestCount;
    session.services = metadata.services;
    session.latestMetadata = metadata;
    this._requestService.take(payload.requestId);
    this._persistSession(sellerPeerId, session, null, usageSig, encodedMetadata);
    debugLog(
      `[BuyerFreeUsage] UsageAuth sent to ${sellerPeerId.slice(0, 12)}... ` +
      `channel=${session.channelId.slice(0, 18)}... sequence=${session.latestSequence}`,
    );
  }

  private async _resolveSellerAddr(peer: PeerInfo): Promise<string> {
    if (!this._sellerAddressResolver) return peerIdToAddress(peer.peerId);
    return this._sellerAddressResolver.resolveSellerAddress(peer.peerId, peer.metadata);
  }

  private _persistSession(
    sellerPeerId: string,
    session: FreeUsageSession,
    openSig: string | null,
    usageSig: string | null,
    encodedMetadata: string | null,
  ): void {
    if (!this._channelStore) return;
    const now = Date.now();
    const existing = this._channelStore.getChannel(session.channelId);
    this._channelStore.upsertChannel({
      sessionId: session.channelId,
      peerId: sellerPeerId,
      role: 'buyer',
      channelKind: 'free',
      sellerEvmAddr: session.sellerEvmAddr,
      buyerEvmAddr: this._identity.wallet.address,
      nonce: 0,
      authMax: '0',
      deadline: session.deadline,
      previousSessionId: '0x' + '00'.repeat(32),
      previousConsumption: session.cumulativeOutputTokens.toString(),
      tokensDelivered: session.cumulativeInputTokens.toString(),
      requestCount: Number(session.cumulativeRequestCount),
      reservedAt: existing?.reservedAt ?? now,
      settledAt: null,
      settledAmount: null,
      status: 'active',
      latestBuyerSig: openSig ?? existing?.latestBuyerSig ?? null,
      latestSpendingAuthSig: usageSig ?? existing?.latestSpendingAuthSig ?? null,
      latestMetadata: encodedMetadata ?? existing?.latestMetadata ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    this._channelStore.replaceMetadataServiceTotals(session.channelId, session.services);
  }
}
