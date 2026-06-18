import { afterEach, describe, expect, it, vi } from 'vitest';
import { BuyerRequestHandler } from '../src/buyer-request-handler.js';
import type { SerializedHttpRequest } from '../src/types/http.js';
import type { SerializedHttpResponse } from '../src/types/http.js';
import type { PeerInfo, PeerId } from '../src/types/peer.js';

function createNoopVerificationMux(): { waitForResponseAuth: ReturnType<typeof vi.fn> } {
  return {
    waitForResponseAuth: vi.fn(() => Promise.reject(new Error('response auth unavailable in test'))),
  };
}

describe('BuyerRequestHandler payment mux wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates buyer payment mux before sending outbound requests when payments are enabled', async () => {
    const peer = { peerId: 'b'.repeat(40) } as PeerInfo;
    const request: SerializedHttpRequest = {
      requestId: 'req-payment-mux',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: new Uint8Array(0),
    };

    const conn = { state: 'open' };
    const sendProxyRequest = vi.fn((
      _: SerializedHttpRequest,
      onResponse: (response: unknown, metadata: { streamingStart: boolean }) => void,
    ) => {
      onResponse({
        requestId: request.requestId,
        statusCode: 200,
        headers: {},
        body: new Uint8Array(0),
      }, { streamingStart: false });
    });

    const estimateCostFromResponse = vi.fn();
    const getOrCreatePaymentMux = vi.fn().mockReturnValue({});
    const registerPaymentMux = vi.fn();
    const handler = new BuyerRequestHandler(
      {},
      {
        localPeerId: 'a'.repeat(40) as PeerId,
        negotiator: {
          getOrCreatePaymentMux,
          preparePreRequestAuth: vi.fn(),
          sendPostResponseAuth: vi.fn(),
          estimateCostFromResponse,
          parseCostHeaders: vi.fn(),
          recordResponseContent: vi.fn(),
        } as any,
        verificationStorage: null,
        verificationSampler: null,
        getConnection: vi.fn(async () => conn) as any,
        getMux: vi.fn(() => ({
          sendProxyRequest,
          cancelProxyRequest: vi.fn(),
        })) as any,
        getVerificationMux: vi.fn(() => createNoopVerificationMux()) as any,
        registerPaymentMux,
      },
    );

    await handler.sendRequest(peer, request);

    expect(getOrCreatePaymentMux).toHaveBeenCalledWith(peer.peerId, conn);
    expect(sendProxyRequest).toHaveBeenCalledOnce();
    expect(estimateCostFromResponse).toHaveBeenCalledWith(
      peer,
      expect.objectContaining({ statusCode: 200 }),
      undefined,
      'req-payment-mux',
    );
    expect(
      getOrCreatePaymentMux.mock.invocationCallOrder[0],
    ).toBeLessThan(sendProxyRequest.mock.invocationCallOrder[0]);
  });

  it('opens free usage and skips paid cost tracking for advertised zero-price services', async () => {
    const peer = {
      peerId: 'b'.repeat(40),
      providerPricing: {
        openai: {
          defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
          services: {
            'gpt-free': { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
          },
        },
      },
    } as PeerInfo;
    const request: SerializedHttpRequest = {
      requestId: 'req-free-usage',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ model: 'gpt-free' })),
    };

    const conn = { state: 'open' };
    const sendProxyRequest = vi.fn((
      _: SerializedHttpRequest,
      onResponse: (response: SerializedHttpResponse, metadata: { streamingStart: boolean }) => void,
    ) => {
      onResponse({
        requestId: request.requestId,
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify({
          usage: { prompt_tokens: 12, completion_tokens: 7 },
        })),
      }, { streamingStart: false });
    });

    const trackRequestService = vi.fn();
    const trackFreeUsageRequestService = vi.fn();
    const prepareFreeUsageOpen = vi.fn(async () => {});
    const estimateCostFromResponse = vi.fn();
    const handler = new BuyerRequestHandler(
      {},
      {
        localPeerId: 'a'.repeat(40) as PeerId,
        negotiator: {
          bpm: { trackRequestService },
          getOrCreatePaymentMux: vi.fn().mockReturnValue({}),
          prepareFreeUsageOpen,
          trackFreeUsageRequestService,
          preparePreRequestAuth: vi.fn(),
          sendPostResponseAuth: vi.fn(),
          estimateCostFromResponse,
          parseCostHeaders: vi.fn(),
          recordResponseContent: vi.fn(),
        } as any,
        verificationStorage: null,
        verificationSampler: null,
        getConnection: vi.fn(async () => conn) as any,
        getMux: vi.fn(() => ({
          sendProxyRequest,
          cancelProxyRequest: vi.fn(),
        })) as any,
        getVerificationMux: vi.fn(() => createNoopVerificationMux()) as any,
        registerPaymentMux: vi.fn(),
      },
    );

    await handler.sendRequest(peer, request);

    expect(trackFreeUsageRequestService).toHaveBeenCalledWith('req-free-usage', 'gpt-free');
    expect(prepareFreeUsageOpen).toHaveBeenCalledWith(peer, conn);
    expect(trackRequestService).not.toHaveBeenCalled();
    expect(estimateCostFromResponse).not.toHaveBeenCalled();
  });

  it('re-negotiates on 402 even when the peer was already locked', async () => {
    const peer = { peerId: 'b'.repeat(40) } as PeerInfo;
    const request: SerializedHttpRequest = {
      requestId: 'req-relock',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: new Uint8Array(0),
    };

    const conn = { state: 'open' };
    const responses: SerializedHttpResponse[] = [
      {
        requestId: request.requestId,
        statusCode: 402,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify({
          error: 'payment_required',
          minBudgetPerRequest: '10000',
          suggestedAmount: '100000',
        })),
      },
      {
        requestId: request.requestId,
        statusCode: 200,
        headers: {},
        body: new Uint8Array(0),
      },
    ];
    const sendProxyRequest = vi.fn((
      _: SerializedHttpRequest,
      onResponse: (response: SerializedHttpResponse, metadata: { streamingStart: boolean }) => void,
    ) => {
      const next = responses.shift();
      if (!next) throw new Error('no more responses');
      onResponse(next, { streamingStart: false });
    });

    const estimateCostFromResponse = vi.fn();
    const handle402 = vi.fn(async () => ({ action: 'retry' as const }));
    const handler = new BuyerRequestHandler(
      {},
      {
        localPeerId: 'a'.repeat(40) as PeerId,
        negotiator: {
          getOrCreatePaymentMux: vi.fn().mockReturnValue({}),
          preparePreRequestAuth: vi.fn(),
          handle402,
          estimateCostFromResponse,
          parseCostHeaders: vi.fn(),
          recordResponseContent: vi.fn(),
        } as any,
        verificationStorage: null,
        verificationSampler: null,
        getConnection: vi.fn(async () => conn) as any,
        getMux: vi.fn(() => ({
          sendProxyRequest,
          cancelProxyRequest: vi.fn(),
        })) as any,
        getVerificationMux: vi.fn(() => createNoopVerificationMux()) as any,
        registerPaymentMux: vi.fn(),
      },
    );

    const response = await handler.sendRequest(peer, request);

    expect(response.statusCode).toBe(200);
    expect(handle402).toHaveBeenCalledOnce();
    expect(estimateCostFromResponse).toHaveBeenCalledTimes(1);
    expect(estimateCostFromResponse).toHaveBeenCalledWith(
      peer,
      expect.objectContaining({ statusCode: 200 }),
      undefined,
      'req-relock',
    );
  });
});
