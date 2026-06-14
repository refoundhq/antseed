import { describe, expect, it, vi } from 'vitest';
import { BuyerRequestHandler } from '../src/buyer-request-handler.js';
import { identityFromPrivateKeyHex } from '../src/p2p/identity.js';
import { createResponseAuthPayload } from '../src/verification/index.js';
import type { PeerInfo, PeerId } from '../src/types/peer.js';
import type { SerializedHttpRequest, SerializedHttpResponse } from '../src/types/http.js';

describe('BuyerRequestHandler response auth sampling', () => {
  it('passes verified response auth evidence to the sampler', async () => {
    const seller = identityFromPrivateKeyHex('11'.repeat(32));
    const buyer = identityFromPrivateKeyHex('22'.repeat(32));
    const peer = { peerId: seller.peerId } as PeerInfo;
    const request: SerializedHttpRequest = {
      requestId: 'req-sampled',
      method: 'POST',
      path: '/v1/messages',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ model: 'sample-model' })),
    };
    const response: SerializedHttpResponse = {
      requestId: request.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] })),
    };
    const responseAuth = createResponseAuthPayload({
      request,
      response,
      buyerPeerId: buyer.peerId,
      sellerPeerId: seller.peerId,
      advertisedService: 'sample-model',
      provider: 'test-provider',
      responseStartedAt: 100,
      responseCompletedAt: 200,
    }, seller.wallet);

    const maybeStoreResponseAuthSample = vi.fn(async () => null);
    const handler = new BuyerRequestHandler(
      {},
      {
        localPeerId: buyer.peerId as PeerId,
        negotiator: null,
        verificationStorage: null,
        verificationSampler: { maybeStoreResponseAuthSample } as any,
        getConnection: vi.fn(async () => ({ state: 'open' })) as any,
        getMux: vi.fn(() => ({
          sendProxyRequest: vi.fn((
            _request: SerializedHttpRequest,
            onResponse: (res: SerializedHttpResponse, metadata: { streamingStart: boolean }) => void,
          ) => {
            onResponse(response, { streamingStart: false });
          }),
          cancelProxyRequest: vi.fn(),
        })) as any,
        getVerificationMux: vi.fn(() => ({
          waitForResponseAuth: vi.fn(async () => responseAuth),
        })) as any,
        registerPaymentMux: vi.fn(),
      },
    );

    await handler.sendRequest(peer, request);

    await vi.waitFor(() => {
      expect(maybeStoreResponseAuthSample).toHaveBeenCalledOnce();
    });
    expect(maybeStoreResponseAuthSample).toHaveBeenCalledWith(expect.objectContaining({
      request,
      response,
      responseAuth,
      verified: true,
      verificationError: null,
    }));
  });
});
