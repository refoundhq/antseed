import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { keccak256, verifyTypedData } from 'ethers';
import { BuyerFreeUsageManager } from '../src/payments/buyer-free-usage-manager.js';
import { SellerFreeUsageManager } from '../src/payments/seller-free-usage-manager.js';
import { ChannelStore } from '../src/payments/channel-store.js';
import { PaymentMux } from '../src/p2p/payment-mux.js';
import { decodeFrame } from '../src/p2p/message-protocol.js';
import {
  decodeFreeUsageAck,
  decodeFreeUsageAuth,
  decodeFreeUsageOpen,
  decodeNeedFreeUsageAuth,
} from '../src/p2p/payment-codec.js';
import { identityFromPrivateKeyHex } from '../src/p2p/identity.js';
import { MessageType, type FreeUsageAuthPayload, type FreeUsageOpenPayload } from '../src/types/protocol.js';
import { peerIdToAddress, type PeerInfo } from '../src/types/peer.js';
import {
  FREE_USAGE_AUTH_TYPES,
  FREE_USAGE_OPEN_TYPES,
  computeFreeUsageChannelId,
  computeFreeUsageMetadataHash,
  encodeFreeUsageMetadata,
  getServiceMetadataId,
  makeFreeUsageDomain,
  signFreeUsageAuth,
} from '../src/payments/evm/signatures.js';

const CHAIN_ID = 31337;
const FREE_USAGE_ADDRESS = '0x0165878A594ca255338adfa4d48449f69242Eb8F';
const AUTH_SECS = 3600;

const buyer = identityFromPrivateKeyHex('22'.repeat(32));
const seller = identityFromPrivateKeyHex('11'.repeat(32));
const attacker = identityFromPrivateKeyHex('33'.repeat(32));

function makeConn() {
  const frames: Uint8Array[] = [];
  return {
    frames,
    conn: {
      send: vi.fn((frame: Uint8Array) => {
        frames.push(frame);
      }),
    },
  };
}

function freeUsageConfig() {
  return {
    chainId: CHAIN_ID,
    freeUsageContractAddress: FREE_USAGE_ADDRESS,
    defaultAuthDurationSecs: AUTH_SECS,
  };
}

function sellerConfig() {
  return {
    rpcUrl: 'http://127.0.0.1:8545',
    freeUsageContractAddress: FREE_USAGE_ADDRESS,
    chainId: CHAIN_ID,
  };
}

function sellerPeer(): PeerInfo {
  return {
    peerId: seller.peerId,
    lastSeen: Date.now(),
    providers: ['openai'],
    providerPricing: {
      openai: {
        defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
        services: {
          'gpt-free': { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
        },
      },
    },
  };
}

function decodeSentFrame(frame: Uint8Array) {
  const decoded = decodeFrame(frame);
  if (!decoded) throw new Error('incomplete frame');
  return decoded.message;
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function installMockClient(manager: SellerFreeUsageManager) {
  const client = {
    open: vi.fn(async () => '0xopen'),
    record: vi.fn(async () => '0xrecord'),
    getSession: vi.fn(async () => {
      throw new Error('missing session');
    }),
  };
  (manager as any)._client = client;
  return client;
}

async function prepareOpen(buyerManager: BuyerFreeUsageManager): Promise<FreeUsageOpenPayload> {
  const buyerConn = makeConn();
  const buyerMux = new PaymentMux(buyerConn.conn as any);

  await buyerManager.prepareOpen(sellerPeer(), buyerMux);

  const openFrame = decodeSentFrame(buyerConn.frames[0]!);
  expect(openFrame.type).toBe(MessageType.FreeUsageOpen);
  return decodeFreeUsageOpen(openFrame.payload);
}

async function openSellerSession(
  sellerManager: SellerFreeUsageManager,
  openPayload: FreeUsageOpenPayload,
  sellerMux: PaymentMux,
) {
  sellerManager.handleOpen(buyer.peerId, openPayload, sellerMux);
  await vi.waitFor(() => {
    expect(sellerManager.client.open).toHaveBeenCalledOnce();
  });
}

describe('FreeUsage P2P lifecycle', () => {
  it('buyer opens and signs free usage without deposits', async () => {
    const buyerManager = new BuyerFreeUsageManager(buyer, freeUsageConfig());
    const buyerConn = makeConn();
    const buyerMux = new PaymentMux(buyerConn.conn as any);

    await buyerManager.prepareOpen(sellerPeer(), buyerMux);

    const openFrame = decodeSentFrame(buyerConn.frames[0]!);
    expect(openFrame.type).toBe(MessageType.FreeUsageOpen);
    const openPayload = decodeFreeUsageOpen(openFrame.payload);
    const expectedChannelId = computeFreeUsageChannelId(
      buyer.wallet.address,
      seller.wallet.address,
      openPayload.salt,
    );
    expect(openPayload.channelId).toBe(expectedChannelId);
    expect(verifyTypedData(
      makeFreeUsageDomain(CHAIN_ID, FREE_USAGE_ADDRESS),
      FREE_USAGE_OPEN_TYPES,
      { channelId: openPayload.channelId, deadline: BigInt(openPayload.deadline) },
      openPayload.openSig,
    ).toLowerCase()).toBe(buyer.wallet.address.toLowerCase());

    buyerManager.handleAck(seller.peerId, {
      channelId: openPayload.channelId,
      acceptedSequence: '0',
    });
    buyerManager.trackRequestService('req-free-1', 'gpt-free');

    await buyerManager.handleNeedAuth(seller.peerId, {
      channelId: openPayload.channelId,
      requiredSequence: '1',
      currentAcceptedSequence: '0',
      requestId: 'req-free-1',
      inputTokens: '12',
      outputTokens: '7',
    }, buyerMux);

    const authFrame = decodeSentFrame(buyerConn.frames[1]!);
    expect(authFrame.type).toBe(MessageType.FreeUsageAuth);
    const authPayload = decodeFreeUsageAuth(authFrame.payload);
    const expectedMetadata = {
      cumulativeInputTokens: 12n,
      cumulativeOutputTokens: 7n,
      cumulativeRequestCount: 1n,
      services: [{
        serviceId: getServiceMetadataId('gpt-free'),
        cumulativeAmount: 0n,
        cumulativeInputTokens: 12n,
        cumulativeCachedInputTokens: 0n,
        cumulativeOutputTokens: 7n,
        cumulativeRequestCount: 1n,
      }],
    };
    expect(authPayload.metadata).toBe(encodeFreeUsageMetadata(expectedMetadata));
    expect(authPayload.metadataHash).toBe(computeFreeUsageMetadataHash(expectedMetadata));
    expect(verifyTypedData(
      makeFreeUsageDomain(CHAIN_ID, FREE_USAGE_ADDRESS),
      FREE_USAGE_AUTH_TYPES,
      {
        channelId: authPayload.channelId,
        sequence: 1n,
        metadataHash: authPayload.metadataHash,
        deadline: BigInt(authPayload.deadline),
      },
      authPayload.usageSig,
    ).toLowerCase()).toBe(buyer.wallet.address.toLowerCase());
  });

  it('persists free usage accounting in the shared channel store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'free-usage-channel-store-'));
    const store = new ChannelStore(dir);
    try {
      const buyerManager = new BuyerFreeUsageManager(buyer, freeUsageConfig(), undefined, store);
      const buyerConn = makeConn();
      const buyerMux = new PaymentMux(buyerConn.conn as any);

      await buyerManager.prepareOpen(sellerPeer(), buyerMux);
      const openPayload = decodeFreeUsageOpen(decodeSentFrame(buyerConn.frames[0]!).payload);

      await buyerManager.handleNeedAuth(seller.peerId, {
        channelId: openPayload.channelId,
        requiredSequence: '1',
        currentAcceptedSequence: '0',
        requestId: 'req-free-store',
        inputTokens: '12',
        outputTokens: '7',
        service: 'gpt-free',
      }, buyerMux);

      expect(store.getActiveChannelByPeer(seller.peerId, 'buyer')).toBeNull();
      const freeChannel = store.getActiveChannelByPeer(seller.peerId, 'buyer', 'free');
      expect(freeChannel).toMatchObject({
        sessionId: openPayload.channelId,
        channelKind: 'free',
        authMax: '0',
        tokensDelivered: '12',
        previousConsumption: '7',
        requestCount: 1,
      });
      expect(freeChannel!.latestMetadata).toBe(decodeFreeUsageAuth(decodeSentFrame(buyerConn.frames[1]!).payload).metadata);

      const serviceTotals = store.getServiceTotals(openPayload.channelId);
      expect(serviceTotals).toEqual([
        expect.objectContaining({
          serviceId: getServiceMetadataId('gpt-free'),
          cumulativeAmount: '0',
          cumulativeInputTokens: '12',
          cumulativeCachedInputTokens: '0',
          cumulativeOutputTokens: '7',
          cumulativeRequestCount: '1',
        }),
      ]);

      const restartedManager = new BuyerFreeUsageManager(buyer, freeUsageConfig(), undefined, store);
      const restartedConn = makeConn();
      const restartedMux = new PaymentMux(restartedConn.conn as any);
      await restartedManager.prepareOpen(sellerPeer(), restartedMux);
      expect(restartedConn.frames).toHaveLength(0);

      restartedManager.trackRequestService('req-free-store-2', 'gpt-free');
      await restartedManager.handleNeedAuth(seller.peerId, {
        channelId: openPayload.channelId,
        requiredSequence: '2',
        currentAcceptedSequence: '1',
        requestId: 'req-free-store-2',
        inputTokens: '3',
        outputTokens: '2',
      }, restartedMux);

      const restartedAuth = decodeFreeUsageAuth(decodeSentFrame(restartedConn.frames[0]!).payload);
      expect(restartedAuth.sequence).toBe('2');
      const updatedFreeChannel = store.getActiveChannelByPeer(seller.peerId, 'buyer', 'free')!;
      expect(updatedFreeChannel.requestCount).toBe(2);
      expect(updatedFreeChannel.tokensDelivered).toBe('15');
      expect(updatedFreeChannel.previousConsumption).toBe('9');
      expect(store.getServiceTotals(openPayload.channelId)).toEqual([
        expect.objectContaining({
          serviceId: getServiceMetadataId('gpt-free'),
          cumulativeAmount: '0',
          cumulativeInputTokens: '15',
          cumulativeCachedInputTokens: '0',
          cumulativeOutputTokens: '9',
          cumulativeRequestCount: '2',
        }),
      ]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('seller verifies open, requests usage auth, and reports the buyer signature', async () => {
    const buyerManager = new BuyerFreeUsageManager(buyer, freeUsageConfig());
    const sellerManager = new SellerFreeUsageManager(seller, sellerConfig());
    const client = installMockClient(sellerManager);
    const sellerConn = makeConn();
    const sellerMux = new PaymentMux(sellerConn.conn as any);
    const openPayload = await prepareOpen(buyerManager);

    await openSellerSession(sellerManager, openPayload, sellerMux);

    expect(client.open).toHaveBeenCalledWith(
      seller.wallet,
      peerIdToAddress(buyer.peerId),
      openPayload.salt,
      BigInt(openPayload.deadline),
      openPayload.openSig,
    );
    const openAckFrame = decodeSentFrame(sellerConn.frames[0]!);
    expect(openAckFrame.type).toBe(MessageType.FreeUsageAck);
    expect(decodeFreeUsageAck(openAckFrame.payload)).toEqual({
      channelId: openPayload.channelId,
      acceptedSequence: '0',
    });

    buyerManager.handleAck(seller.peerId, {
      channelId: openPayload.channelId,
      acceptedSequence: '0',
    });
    buyerManager.trackRequestService('req-free-1', 'gpt-free');
    sellerConn.frames.length = 0;

    sellerManager.reportUsageRequest(buyer.peerId, sellerMux, {
      requestId: 'req-free-1',
      inputTokens: 12,
      outputTokens: 7,
      service: 'gpt-free',
    });

    const needFrame = decodeSentFrame(sellerConn.frames[0]!);
    expect(needFrame.type).toBe(MessageType.NeedFreeUsageAuth);
    const needPayload = decodeNeedFreeUsageAuth(needFrame.payload);
    expect(needPayload).toMatchObject({
      channelId: openPayload.channelId,
      requiredSequence: '1',
      currentAcceptedSequence: '0',
      requestId: 'req-free-1',
      inputTokens: '12',
      outputTokens: '7',
      service: 'gpt-free',
    });

    const buyerConn = makeConn();
    const buyerMux = new PaymentMux(buyerConn.conn as any);
    await buyerManager.handleNeedAuth(seller.peerId, needPayload, buyerMux);
    const authPayload = decodeFreeUsageAuth(decodeSentFrame(buyerConn.frames[0]!).payload);

    sellerConn.frames.length = 0;
    sellerManager.handleAuth(buyer.peerId, authPayload, sellerMux);
    await vi.waitFor(() => {
      expect(client.record).toHaveBeenCalledOnce();
    });

    expect(client.record).toHaveBeenCalledWith(
      seller.wallet,
      openPayload.channelId,
      1n,
      authPayload.metadata,
      BigInt(authPayload.deadline),
      authPayload.usageSig,
    );
    const recordAck = decodeFreeUsageAck(decodeSentFrame(sellerConn.frames[0]!).payload);
    expect(recordAck).toEqual({
      channelId: openPayload.channelId,
      acceptedSequence: '1',
    });
  });

  it('seller rejects wrong channel, wrong signer, metadata mismatch, and stale sequences', async () => {
    const buyerManager = new BuyerFreeUsageManager(buyer, freeUsageConfig());
    const sellerManager = new SellerFreeUsageManager(seller, sellerConfig());
    const client = installMockClient(sellerManager);
    const sellerConn = makeConn();
    const sellerMux = new PaymentMux(sellerConn.conn as any);
    const openPayload = await prepareOpen(buyerManager);

    await openSellerSession(sellerManager, openPayload, sellerMux);
    buyerManager.handleAck(seller.peerId, {
      channelId: openPayload.channelId,
      acceptedSequence: '0',
    });

    const buyerConn = makeConn();
    const buyerMux = new PaymentMux(buyerConn.conn as any);
    buyerManager.trackRequestService('req-free-1', 'gpt-free');
    await buyerManager.handleNeedAuth(seller.peerId, {
      channelId: openPayload.channelId,
      requiredSequence: '1',
      currentAcceptedSequence: '0',
      requestId: 'req-free-1',
      inputTokens: '12',
      outputTokens: '7',
    }, buyerMux);
    const validAuth = decodeFreeUsageAuth(decodeSentFrame(buyerConn.frames[0]!).payload);

    client.record.mockClear();
    sellerConn.frames.length = 0;
    sellerManager.handleAuth(buyer.peerId, {
      ...validAuth,
      channelId: '0x' + '44'.repeat(32),
    }, sellerMux);
    await flushAsync();
    expect(client.record).not.toHaveBeenCalled();
    expect(sellerConn.frames).toHaveLength(0);

    const metadataHashMismatch: FreeUsageAuthPayload = {
      ...validAuth,
      metadataHash: '0x' + '99'.repeat(32),
    };
    sellerManager.handleAuth(buyer.peerId, metadataHashMismatch, sellerMux);
    await flushAsync();
    expect(client.record).not.toHaveBeenCalled();
    expect(sellerConn.frames).toHaveLength(0);

    const metadata = encodeFreeUsageMetadata({
      cumulativeInputTokens: 12n,
      cumulativeOutputTokens: 7n,
      cumulativeRequestCount: 1n,
      services: [{
        serviceId: getServiceMetadataId('gpt-free'),
        cumulativeAmount: 0n,
        cumulativeInputTokens: 12n,
        cumulativeCachedInputTokens: 0n,
        cumulativeOutputTokens: 7n,
        cumulativeRequestCount: 1n,
      }],
    });
    const wrongSignerAuth: FreeUsageAuthPayload = {
      ...validAuth,
      metadata,
      metadataHash: keccak256(metadata),
      usageSig: await signFreeUsageAuth(
        attacker.wallet,
        makeFreeUsageDomain(CHAIN_ID, FREE_USAGE_ADDRESS),
        {
          channelId: openPayload.channelId,
          sequence: 1n,
          metadataHash: keccak256(metadata),
          deadline: BigInt(validAuth.deadline),
        },
      ),
    };
    sellerManager.handleAuth(buyer.peerId, wrongSignerAuth, sellerMux);
    await flushAsync();
    expect(client.record).not.toHaveBeenCalled();
    expect(sellerConn.frames).toHaveLength(0);

    sellerManager.handleAuth(buyer.peerId, validAuth, sellerMux);
    await vi.waitFor(() => {
      expect(client.record).toHaveBeenCalledOnce();
    });

    client.record.mockClear();
    sellerConn.frames.length = 0;
    sellerManager.handleAuth(buyer.peerId, validAuth, sellerMux);
    await flushAsync();

    expect(client.record).not.toHaveBeenCalled();
    expect(decodeFreeUsageAck(decodeSentFrame(sellerConn.frames[0]!).payload)).toEqual({
      channelId: openPayload.channelId,
      acceptedSequence: '1',
    });
  });

  it('seller rejects FreeUsageOpen with a mismatched channel id or signer', async () => {
    const buyerManager = new BuyerFreeUsageManager(buyer, freeUsageConfig());
    const sellerManager = new SellerFreeUsageManager(seller, sellerConfig());
    const client = installMockClient(sellerManager);
    const sellerConn = makeConn();
    const sellerMux = new PaymentMux(sellerConn.conn as any);
    const openPayload = await prepareOpen(buyerManager);

    sellerManager.handleOpen(buyer.peerId, {
      ...openPayload,
      channelId: '0x' + '55'.repeat(32),
    }, sellerMux);
    await flushAsync();
    expect(client.open).not.toHaveBeenCalled();
    expect(sellerConn.frames).toHaveLength(0);

    const attackerChannelId = computeFreeUsageChannelId(
      attacker.wallet.address,
      seller.wallet.address,
      openPayload.salt,
    );
    const attackerOpenSig = await attacker.wallet.signTypedData(
      makeFreeUsageDomain(CHAIN_ID, FREE_USAGE_ADDRESS),
      FREE_USAGE_OPEN_TYPES,
      { channelId: attackerChannelId, deadline: BigInt(openPayload.deadline) },
    );

    sellerManager.handleOpen(buyer.peerId, {
      ...openPayload,
      openSig: attackerOpenSig,
    }, sellerMux);
    await flushAsync();
    expect(client.open).not.toHaveBeenCalled();
    expect(sellerConn.frames).toHaveLength(0);
  });
});
