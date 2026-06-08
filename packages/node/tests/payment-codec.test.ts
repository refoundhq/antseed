import { describe, it, expect } from 'vitest';
import {
  encodeSpendingAuth, decodeSpendingAuth,
  encodeAuthAck, decodeAuthAck,
  encodePaymentRequired, decodePaymentRequired,
  encodeNeedAuth, decodeNeedAuth,
} from '../src/p2p/payment-codec.js';

describe('payment codec round-trips', () => {
  it('SpendingAuth', () => {
    const payload = {
      channelId: '0x' + 'aa'.repeat(32),
      cumulativeAmount: '1000000',
      metadataHash: '0x' + 'cc'.repeat(32),
      metadata: '0x' + 'dd'.repeat(128),
      spendingAuthSig: '0x' + 'ee'.repeat(65),
    };
    const encoded = encodeSpendingAuth(payload);
    const decoded = decodeSpendingAuth(encoded);
    expect(decoded).toEqual(payload);
  });

  it('AuthAck', () => {
    const payload = { channelId: '0x' + 'aa'.repeat(32) };
    expect(decodeAuthAck(encodeAuthAck(payload))).toEqual(payload);
  });

  it('PaymentRequired', () => {
    const payload = {
      minBudgetPerRequest: '10000',
      suggestedAmount: '100000',
      requestId: 'req-123',
    };
    const encoded = encodePaymentRequired(payload);
    const decoded = decodePaymentRequired(encoded);
    expect(decoded).toEqual(payload);
  });

  it('PaymentRequired with optional pricing fields', () => {
    const payload = {
      minBudgetPerRequest: '10000',
      suggestedAmount: '100000',
      requestId: 'req-456',
      inputUsdPerMillion: 3000,
      outputUsdPerMillion: 15000,
    };
    const encoded = encodePaymentRequired(payload);
    const decoded = decodePaymentRequired(encoded);
    expect(decoded).toEqual(payload);
  });

  it('PaymentRequired with budget-exhausted catch-up fields', () => {
    const payload = {
      minBudgetPerRequest: '10000',
      suggestedAmount: '1000000',
      requestId: 'req-789',
      inputUsdPerMillion: 0.36,
      outputUsdPerMillion: 1.65,
      cachedInputUsdPerMillion: 0.07,
      requiredCumulativeAmount: '85119',
      currentSpent: '85119',
      currentAcceptedCumulative: '56218',
      channelId: '0x' + 'aa'.repeat(32),
    };
    const encoded = encodePaymentRequired(payload);
    const decoded = decodePaymentRequired(encoded);
    expect(decoded).toEqual(payload);
  });

  it('PaymentRequired with channel_exhausted code and reserveMaxAmount', () => {
    const payload = {
      minBudgetPerRequest: '10000',
      suggestedAmount: '1000000',
      requestId: 'req-exhausted',
      requiredCumulativeAmount: '11019626',
      currentSpent: '11009626',
      currentAcceptedCumulative: '10998222',
      channelId: '0x' + 'cd'.repeat(32),
      reserveMaxAmount: '11000000',
      code: 'channel_exhausted' as const,
    };
    const encoded = encodePaymentRequired(payload);
    const decoded = decodePaymentRequired(encoded);
    expect(decoded).toEqual(payload);
  });

  it('NeedAuth', () => {
    const payload = {
      channelId: '0x' + 'aa'.repeat(32),
      requiredCumulativeAmount: '500000',
      currentAcceptedCumulative: '200000',
      deposit: '1000000',
    };
    const encoded = encodeNeedAuth(payload);
    const decoded = decodeNeedAuth(encoded);
    expect(decoded).toEqual(payload);
  });

  it('NeedAuth with usage report metadata', () => {
    const payload = {
      channelId: '0x' + '11'.repeat(32),
      requiredCumulativeAmount: '25',
      currentAcceptedCumulative: '10',
      deposit: '100',
      requestId: 'req-1',
      lastRequestCost: '15',
      inputTokens: '7',
      outputTokens: '5',
      cachedInputTokens: '2',
      freshInputTokens: '5',
      service: 'model-a',
      usageReportMetadata: {
        pricingCatalogRoot: '0x' + '22'.repeat(32),
        serviceUsageRoot: '0x' + '33'.repeat(32),
        receiptRoot: '0x' + '44'.repeat(32),
        cumulativeFreshInputTokens: '5',
        cumulativeCachedInputTokens: '2',
        cumulativeOutputTokens: '5',
        cumulativeRequestCount: '1',
        cumulativeAmountPaid: '25',
      },
    };
    const encoded = encodeNeedAuth(payload);
    const decoded = decodeNeedAuth(encoded);
    expect(decoded).toEqual(payload);
  });
});
