import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import type { Identity } from '../src/p2p/identity.js';
import type { PeerConnection } from '../src/p2p/connection-manager.js';
import { VerificationMux } from '../src/p2p/verification-mux.js';
import { decodeFrame } from '../src/p2p/message-protocol.js';
import { MessageType, type FramedMessage, type VerificationUsageClaimPayload } from '../src/types/protocol.js';
import * as codec from '../src/p2p/verification-codec.js';
import { UsageVerificationStore, type UsageAttestationRecord } from '../src/payments/usage-verification-store.js';
import {
  BuyerUsageVerificationManager,
  type BuyerUsageVerificationValidationSource,
  SellerUsageVerificationManager,
  claimPayloadToMessage,
} from '../src/payments/usage-verification-manager.js';
import {
  computeServiceKey,
  computeUsageClaimHash,
  computeUsageRevealHash,
  makeUsageVerificationDomain,
  signUsageCommit,
  USAGE_CLAIM_VERSION,
  USAGE_PARTY_BUYER,
  USAGE_PARTY_SELLER,
} from '../src/payments/evm/signatures.js';

const CHAIN_ID = 31337;
const USAGE_CONTRACT = '0x' + '90'.repeat(20);
const CHANNEL_ID = '0x' + '11'.repeat(32);
const SELLER_NONCE = '0x' + '22'.repeat(32);
const BUYER_NONCE = '0x' + '33'.repeat(32);
const REQUEST_ID = 'req-usage-1';
const SELLER_PEER_ID = 'seller-peer-1';

function identity(wallet: Wallet): Identity {
  return {
    wallet,
    peerId: wallet.address.slice(2).toLowerCase() as Identity['peerId'],
    privateKey: new Uint8Array(),
  };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'usage-verification-test-'));
}

function config(dataDir: string) {
  return {
    rpcUrl: 'http://127.0.0.1:8545',
    contractAddress: USAGE_CONTRACT,
    chainId: CHAIN_ID,
    dataDir,
  };
}

function makeClaim(overrides: Partial<VerificationUsageClaimPayload> = {}): VerificationUsageClaimPayload {
  const buyer = overrides.buyer ?? Wallet.createRandom().address;
  const seller = overrides.seller ?? Wallet.createRandom().address;
  return {
    version: USAGE_CLAIM_VERSION.toString(),
    channelId: CHANNEL_ID,
    buyer,
    seller,
    sellerAgentId: '7',
    serviceKey: computeServiceKey('openai', 'gpt-4o-mini'),
    providerName: 'openai',
    serviceName: 'gpt-4o-mini',
    cumulativeInputTokens: '100',
    cumulativeCachedInputTokens: '10',
    cumulativeFreshInputTokens: '90',
    cumulativeOutputTokens: '25',
    cumulativeRequestCount: '1',
    cumulativeCostUsdc: '2500',
    paymentCumulativeAmount: '2500',
    ...overrides,
  };
}

async function signedCommitRequest(options: {
  buyer: Wallet;
  seller: Wallet;
  claim?: Partial<VerificationUsageClaimPayload>;
  signer?: Wallet;
  expectedEpoch?: string;
}) {
  const expectedEpoch = options.expectedEpoch ?? '0';
  const claim = makeClaim({
    buyer: options.buyer.address,
    seller: options.seller.address,
    ...options.claim,
  });
  const claimHash = computeUsageClaimHash(claimPayloadToMessage(claim));
  const sellerRevealHash = computeUsageRevealHash(claimHash, SELLER_NONCE);
  const signer = options.signer ?? options.seller;
  const sellerSig = await signUsageCommit(
    signer,
    makeUsageVerificationDomain(CHAIN_ID, USAGE_CONTRACT),
    {
      claimHash,
      revealHash: sellerRevealHash,
      expectedEpoch: BigInt(expectedEpoch),
      party: USAGE_PARTY_SELLER,
    },
  );
  return {
    requestId: REQUEST_ID,
    claim,
    claimHash,
    revealHash: sellerRevealHash,
    expectedEpoch,
    sellerSig,
  };
}

function captureMux() {
  return {
    sentCommitRequests: [] as unknown[],
    sentCommitResponses: [] as unknown[],
    sentCommitProofs: [] as unknown[],
    sentRevealPackages: [] as unknown[],
    sentRevealResponses: [] as unknown[],
    sendCommitRequest(payload: unknown) {
      this.sentCommitRequests.push(payload);
    },
    sendCommitResponse(payload: unknown) {
      this.sentCommitResponses.push(payload);
    },
    sendCommitProof(payload: unknown) {
      this.sentCommitProofs.push(payload);
    },
    sendRevealPackage(payload: unknown) {
      this.sentRevealPackages.push(payload);
    },
    sendRevealResponse(payload: unknown) {
      this.sentRevealResponses.push(payload);
    },
  } as unknown as VerificationMux & {
    sentCommitRequests: unknown[];
    sentCommitResponses: unknown[];
    sentCommitProofs: unknown[];
    sentRevealPackages: unknown[];
    sentRevealResponses: unknown[];
  };
}

describe('usage verification buyer validation', () => {
  let dir: string;
  let buyer: Wallet;
  let seller: Wallet;
  let manager: BuyerUsageVerificationManager;
  let validationSource: BuyerUsageVerificationValidationSource;

  beforeEach(() => {
    dir = tempDir();
    buyer = Wallet.createRandom();
    seller = Wallet.createRandom();
    validationSource = {
      getActiveSession: vi.fn(() => ({
        sessionId: CHANNEL_ID,
        peerId: SELLER_PEER_ID,
        role: 'buyer',
        buyerEvmAddr: buyer.address,
        sellerEvmAddr: seller.address,
        nonce: 1,
        authMax: '2500',
        deadline: Math.floor(Date.now() / 1000) + 900,
        previousSessionId: '0x' + '00'.repeat(32),
        previousConsumption: '25',
        tokensDelivered: '100',
        requestCount: 1,
        reservedAt: Date.now(),
        settledAt: null,
        settledAmount: null,
        status: 'active',
        latestBuyerSig: null,
        latestSpendingAuthSig: null,
        latestMetadata: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })),
      getResponseTokenTotals: vi.fn(() => ({ input: 100, output: 25, requests: 1 })),
      getVerifiedCost: vi.fn(() => 2500n),
      getCumulativeAmount: vi.fn(() => 2500n),
      getCurrentEpoch: vi.fn(() => 0n),
    };
    manager = new BuyerUsageVerificationManager(identity(buyer), config(dir), validationSource);
    manager.trackRequestService(REQUEST_ID, 'gpt-4o-mini', SELLER_PEER_ID);
  });

  afterEach(() => {
    manager.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a commit request whose seller signature was made by a different key', async () => {
    const attacker = Wallet.createRandom();
    const mux = captureMux();
    const payload = await signedCommitRequest({ buyer, seller, signer: attacker });

    await manager.handleCommitRequest(payload, mux);

    expect(mux.sentCommitResponses).toHaveLength(1);
    expect(mux.sentCommitResponses[0]).toMatchObject({
      requestId: REQUEST_ID,
      accepted: false,
      claimHash: payload.claimHash,
    });
  });

  it('rejects a commit request whose channel does not belong to the claimed buyer and seller', async () => {
    const mux = captureMux();
    const payload = await signedCommitRequest({
      buyer,
      seller,
      claim: { channelId: '0x' + '44'.repeat(32) },
    });

    await manager.handleCommitRequest(payload, mux);

    expect(mux.sentCommitResponses).toHaveLength(1);
    expect(mux.sentCommitResponses[0]).toMatchObject({
      requestId: REQUEST_ID,
      accepted: false,
      claimHash: payload.claimHash,
    });
  });

  it('rejects a commit request with inflated cumulative usage beyond the buyer observed totals', async () => {
    const mux = captureMux();
    const payload = await signedCommitRequest({
      buyer,
      seller,
      claim: {
        cumulativeInputTokens: '999999',
        cumulativeFreshInputTokens: '999999',
        cumulativeOutputTokens: '999999',
        cumulativeRequestCount: '999',
        cumulativeCostUsdc: '999999',
        paymentCumulativeAmount: '999999',
      },
    });

    await manager.handleCommitRequest(payload, mux);

    expect(mux.sentCommitResponses).toHaveLength(1);
    expect(mux.sentCommitResponses[0]).toMatchObject({
      requestId: REQUEST_ID,
      accepted: false,
      claimHash: payload.claimHash,
    });
  });

  it('rejects a commit request for a stale epoch', async () => {
    const mux = captureMux();
    const payload = await signedCommitRequest({ buyer, seller, expectedEpoch: '99' });

    await manager.handleCommitRequest(payload, mux);

    expect(mux.sentCommitResponses).toHaveLength(1);
    expect(mux.sentCommitResponses[0]).toMatchObject({
      requestId: REQUEST_ID,
      accepted: false,
      claimHash: payload.claimHash,
      reason: 'epoch mismatch',
    });
  });
});

describe('usage verification seller retry behavior', () => {
  it('submits commitPair after the buyer accepts the seller usage commit', async () => {
    const dir = tempDir();
    const buyer = Wallet.createRandom();
    const seller = Wallet.createRandom();
    const manager = new SellerUsageVerificationManager(identity(seller), config(dir));
    const mux = captureMux();
    const currentEpoch = vi.fn().mockResolvedValue(0n);
    const commitPair = vi.fn().mockResolvedValue('0xcommit');
    (manager.client as unknown as { currentEpoch: typeof currentEpoch; commitPair: typeof commitPair }).currentEpoch = currentEpoch;
    (manager.client as unknown as { currentEpoch: typeof currentEpoch; commitPair: typeof commitPair }).commitPair = commitPair;

    await manager.recordAndRequestCommit({
      requestId: REQUEST_ID,
      channel: {
        sessionId: CHANNEL_ID,
        peerId: SELLER_PEER_ID,
        role: 'seller',
        buyerEvmAddr: buyer.address,
        sellerEvmAddr: seller.address,
        nonce: 1,
        authMax: '2500',
        deadline: Math.floor(Date.now() / 1000) + 900,
        previousSessionId: '0x' + '00'.repeat(32),
        previousConsumption: '0',
        tokensDelivered: '0',
        requestCount: 0,
        reservedAt: Date.now(),
        settledAt: null,
        settledAmount: null,
        status: 'active',
        latestBuyerSig: null,
        latestSpendingAuthSig: null,
        latestMetadata: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      providerName: 'openai',
      serviceName: 'gpt-4o-mini',
      inputTokens: 100n,
      cachedInputTokens: 10n,
      freshInputTokens: 90n,
      outputTokens: 25n,
      costUsdc: 2500n,
      paymentCumulativeAmount: 2500n,
      mux,
    });

    expect(mux.sentCommitRequests).toHaveLength(1);
    const request = mux.sentCommitRequests[0] as Awaited<ReturnType<typeof signedCommitRequest>>;
    const buyerRevealHash = computeUsageRevealHash(request.claimHash, BUYER_NONCE);
    const buyerSig = await signUsageCommit(
      buyer,
      makeUsageVerificationDomain(CHAIN_ID, USAGE_CONTRACT),
      {
        claimHash: request.claimHash,
        revealHash: buyerRevealHash,
        expectedEpoch: BigInt(request.expectedEpoch),
        party: USAGE_PARTY_BUYER,
      },
    );

    await manager.handleCommitResponse({
      requestId: REQUEST_ID,
      accepted: true,
      claimHash: request.claimHash,
      revealHash: buyerRevealHash,
      buyerSig,
    }, mux);

    manager.close();
    rmSync(dir, { recursive: true, force: true });

    expect(commitPair).toHaveBeenCalledTimes(1);
    expect(commitPair.mock.calls[0][1]).toMatchObject({
      claimHash: request.claimHash,
      channelId: CHANNEL_ID,
      buyer: buyer.address,
      seller: seller.address,
      expectedEpoch: 0n,
      buyerRevealHash,
      buyerSig,
    });
    expect(mux.sentCommitProofs).toHaveLength(1);
    expect(mux.sentRevealPackages).toHaveLength(1);
    expect(mux.sentRevealPackages[0]).toMatchObject({
      requestId: REQUEST_ID,
      claimHash: request.claimHash,
      party: 'seller',
    });
  });

  it('does not retry the same permanently failing committed reveal forever', async () => {
    const dir = tempDir();
    const seller = Wallet.createRandom();
    const manager = new SellerUsageVerificationManager(identity(seller), config(dir));
    const claim = makeClaim({ seller: seller.address });
    const claimHash = computeUsageClaimHash(claimPayloadToMessage(claim));
    const now = Date.now();
    const store = new UsageVerificationStore(dir);
    store.upsertAttestation({
      claimHash,
      requestId: REQUEST_ID,
      channelId: claim.channelId,
      serviceKey: claim.serviceKey,
      epoch: '0',
      claim,
      buyerRevealHash: computeUsageRevealHash(claimHash, BUYER_NONCE),
      sellerRevealHash: computeUsageRevealHash(claimHash, SELLER_NONCE),
      buyerNonce: BUYER_NONCE,
      sellerNonce: SELLER_NONCE,
      buyerSig: '0x' + 'aa'.repeat(65),
      sellerSig: '0x' + 'bb'.repeat(65),
      commitTxHash: '0xcommit',
      revealTxHash: null,
      status: 'committed',
      createdAt: now,
      updatedAt: now,
    });
    store.close();

    const revealPair = vi.fn().mockRejectedValue(new Error('execution reverted: InvalidCommit'));
    (manager.client as unknown as { revealPair: typeof revealPair }).revealPair = revealPair;

    await manager.retryCommittedReveals();
    await manager.retryCommittedReveals();

    const verifyStore = new UsageVerificationStore(dir);
    const attestation = verifyStore.getAttestation(claimHash);
    verifyStore.close();
    manager.close();
    rmSync(dir, { recursive: true, force: true });

    expect(revealPair).toHaveBeenCalledTimes(1);
    expect(attestation?.status).toBe('failed');
  });

  it('backs off transient committed reveal failures instead of retrying every pass', async () => {
    const dir = tempDir();
    const seller = Wallet.createRandom();
    const manager = new SellerUsageVerificationManager(identity(seller), config(dir));
    const claim = makeClaim({ seller: seller.address });
    const claimHash = computeUsageClaimHash(claimPayloadToMessage(claim));
    const now = Date.now();
    const store = new UsageVerificationStore(dir);
    store.upsertAttestation({
      claimHash,
      requestId: REQUEST_ID,
      channelId: claim.channelId,
      serviceKey: claim.serviceKey,
      epoch: '0',
      claim,
      buyerRevealHash: computeUsageRevealHash(claimHash, BUYER_NONCE),
      sellerRevealHash: computeUsageRevealHash(claimHash, SELLER_NONCE),
      buyerNonce: BUYER_NONCE,
      sellerNonce: SELLER_NONCE,
      buyerSig: '0x' + 'aa'.repeat(65),
      sellerSig: '0x' + 'bb'.repeat(65),
      commitTxHash: '0xcommit',
      revealTxHash: null,
      status: 'committed',
      createdAt: now,
      updatedAt: now,
    });
    store.close();

    const revealPair = vi.fn().mockRejectedValue(new Error('execution reverted: PaymentNotCovered'));
    (manager.client as unknown as { revealPair: typeof revealPair }).revealPair = revealPair;

    await manager.retryCommittedReveals();
    await manager.retryCommittedReveals();

    const verifyStore = new UsageVerificationStore(dir);
    const attestation = verifyStore.getAttestation(claimHash);
    verifyStore.close();
    manager.close();
    rmSync(dir, { recursive: true, force: true });

    expect(revealPair).toHaveBeenCalledTimes(1);
    expect(attestation?.status).toBe('committed');
    expect(attestation?.attemptCount).toBe(1);
    expect(attestation?.lastError).toContain('PaymentNotCovered');
    expect(attestation?.nextRetryAt ?? 0).toBeGreaterThan(now);
  });
});

describe('usage verification store', () => {
  it('runs channel migrations and persists snapshots and attestations across reopen', () => {
    const dir = tempDir();
    const claim = makeClaim();
    const claimHash = computeUsageClaimHash(claimPayloadToMessage(claim));
    const now = Date.now();
    const store = new UsageVerificationStore(dir);

    store.upsertSnapshot({
      channelId: claim.channelId,
      serviceKey: claim.serviceKey,
      providerName: claim.providerName,
      serviceName: claim.serviceName,
      epoch: '0',
      buyerEvmAddr: claim.buyer,
      sellerEvmAddr: claim.seller,
      sellerAgentId: claim.sellerAgentId,
      cumulativeInputTokens: claim.cumulativeInputTokens,
      cumulativeCachedInputTokens: claim.cumulativeCachedInputTokens,
      cumulativeFreshInputTokens: claim.cumulativeFreshInputTokens,
      cumulativeOutputTokens: claim.cumulativeOutputTokens,
      cumulativeRequestCount: claim.cumulativeRequestCount,
      cumulativeCostUsdc: claim.cumulativeCostUsdc,
      paymentCumulativeAmount: claim.paymentCumulativeAmount,
      createdAt: now,
      updatedAt: now,
    });
    store.upsertAttestation(makeAttestation(claimHash, claim, now));
    store.close();

    const reopened = new UsageVerificationStore(dir);
    expect(reopened.getSnapshot(claim.channelId, claim.serviceKey, '0')).toMatchObject({
      channelId: claim.channelId,
      serviceKey: claim.serviceKey,
      cumulativeInputTokens: claim.cumulativeInputTokens,
    });
    expect(reopened.getAttestation(claimHash)).toMatchObject({
      claimHash,
      status: 'pending_buyer',
      claim,
    });
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('usage verification codec and mux', () => {
  it('rejects oversized and malformed commit requests', () => {
    expect(() => codec.decodeVerificationCommitRequest(new Uint8Array(65537))).toThrow(/too large/);
    expect(() => codec.decodeVerificationCommitRequest(new TextEncoder().encode('[]'))).toThrow(/Expected JSON object/);
    expect(() => codec.decodeVerificationCommitRequest(codec.encodeVerificationCommitRequest({}))).toThrow(/requestId/);
  });

  it('dispatches verification frames and ignores non-verification frames', async () => {
    const connection = { send: vi.fn() } as unknown as PeerConnection;
    const mux = new VerificationMux(connection);
    const handler = vi.fn();
    mux.onRevealPackage(handler);
    const claim = makeClaim();
    const payload = {
      requestId: REQUEST_ID,
      claim,
      claimHash: computeUsageClaimHash(claimPayloadToMessage(claim)),
      nonce: SELLER_NONCE,
      party: 'seller' as const,
    };

    const handled = await mux.handleFrame({
      type: MessageType.VerificationRevealPackage,
      messageId: 1,
      payload: codec.encodeVerificationRevealPackage(payload),
    });
    const ignored = await mux.handleFrame({
      type: MessageType.HttpRequest,
      messageId: 2,
      payload: new Uint8Array(),
    } as FramedMessage);

    mux.sendRevealAck({ requestId: REQUEST_ID, claimHash: payload.claimHash, txHash: '0xabc' });
    const sent = decodeFrame((connection.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);

    expect(handled).toBe(true);
    expect(ignored).toBe(false);
    expect(handler).toHaveBeenCalledWith(payload);
    expect(sent?.message.type).toBe(MessageType.VerificationRevealAck);
  });
});

function makeAttestation(claimHash: string, claim: VerificationUsageClaimPayload, now: number): UsageAttestationRecord {
  return {
    claimHash,
    requestId: REQUEST_ID,
    channelId: claim.channelId,
    serviceKey: claim.serviceKey,
    epoch: '0',
    claim,
    buyerRevealHash: null,
    sellerRevealHash: computeUsageRevealHash(claimHash, SELLER_NONCE),
    buyerNonce: null,
    sellerNonce: SELLER_NONCE,
    buyerSig: null,
    sellerSig: '0x' + 'aa'.repeat(65),
    commitTxHash: null,
    revealTxHash: null,
    status: 'pending_buyer',
    createdAt: now,
    updatedAt: now,
  };
}
