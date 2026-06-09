import { describe, expect, it } from 'vitest';
import {
  SERVICE_MODE_FREE,
  SERVICE_MODE_PAID,
  ZERO_BYTES32,
  computeEncodedMetadataHash,
  computePricingCatalogRoot,
  computeServiceUsageRoot,
  decodeMetadata,
  encodeMetadata,
  encodeMetadataV2,
  hashServicePricing,
  hashUtf8,
  metadataV2MatchesServiceUsage,
  type ServiceUsageRow,
  type SpendingAuthMetadataV2,
} from './signatures.js';

const channelId = `0x${'11'.repeat(32)}`;

describe('spending auth metadata helpers', () => {
  it('keeps V1 metadata backward-compatible', () => {
    const encoded = encodeMetadata({
      cumulativeInputTokens: 123n,
      cumulativeOutputTokens: 45n,
      cumulativeRequestCount: 6n,
    });

    expect(decodeMetadata(encoded)).toEqual({
      version: 1n,
      cumulativeInputTokens: 123n,
      cumulativeOutputTokens: 45n,
      cumulativeRequestCount: 6n,
    });
  });

  it('encodes and decodes V2 metadata with service usage root and split input totals', () => {
    const metadata: SpendingAuthMetadataV2 = {
      pricingCatalogRoot: `0x${'aa'.repeat(32)}`,
      serviceUsageRoot: `0x${'bb'.repeat(32)}`,
      receiptRoot: ZERO_BYTES32,
      buyerSelectionSalt: `0x${'cc'.repeat(32)}`,
      cumulativeInputTokens: 100n,
      cumulativeCachedInputTokens: 25n,
      cumulativeOutputTokens: 50n,
      cumulativeRequestCount: 3n,
      cumulativeAmountPaid: 12_345n,
    };

    const encoded = encodeMetadataV2(metadata);
    expect(computeEncodedMetadataHash(encoded)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(decodeMetadata(encoded)).toEqual({ version: 2n, ...metadata });
  });

  it('computes order-independent pricing catalog and service usage roots', () => {
    const paidPricing = {
      serviceIdHash: hashUtf8('openai:gpt-4.1'),
      inputUsdPerMillion: 2_000_000n,
      cachedInputUsdPerMillion: 500_000n,
      outputUsdPerMillion: 8_000_000n,
      serviceMode: SERVICE_MODE_PAID,
    };
    const freePricing = {
      serviceIdHash: hashUtf8('local:free-demo'),
      inputUsdPerMillion: 0n,
      cachedInputUsdPerMillion: 0n,
      outputUsdPerMillion: 0n,
      serviceMode: SERVICE_MODE_FREE,
    };
    const usageRows: ServiceUsageRow[] = [
      {
        channelId,
        provider: 'openai',
        service: 'gpt-4.1',
        servicePricingHash: hashServicePricing(paidPricing),
        ...paidPricing,
        cumulativeInputTokens: 120n,
        cumulativeCachedInputTokens: 20n,
        cumulativeOutputTokens: 80n,
        cumulativeRequestCount: 2n,
        cumulativeAmountPaid: 90_000n,
      },
      {
        channelId,
        provider: 'local',
        service: 'free-demo',
        servicePricingHash: hashServicePricing(freePricing),
        ...freePricing,
        cumulativeInputTokens: 10n,
        cumulativeCachedInputTokens: 0n,
        cumulativeOutputTokens: 5n,
        cumulativeRequestCount: 1n,
        cumulativeAmountPaid: 0n,
      },
    ];

    expect(computePricingCatalogRoot([])).toBe(ZERO_BYTES32);
    expect(computePricingCatalogRoot([paidPricing, freePricing]))
      .toBe(computePricingCatalogRoot([freePricing, paidPricing]));
    expect(computePricingCatalogRoot([paidPricing])).not.toBe(computePricingCatalogRoot([paidPricing, freePricing]));
    expect(computeServiceUsageRoot([])).toBe(ZERO_BYTES32);
    expect(computeServiceUsageRoot(usageRows)).toBe(computeServiceUsageRoot([...usageRows].reverse()));
    expect(computeServiceUsageRoot(usageRows.slice(0, 1))).not.toBe(computeServiceUsageRoot(usageRows));

    const metadata: SpendingAuthMetadataV2 = {
      pricingCatalogRoot: `0x${'aa'.repeat(32)}`,
      serviceUsageRoot: computeServiceUsageRoot(usageRows),
      receiptRoot: ZERO_BYTES32,
      buyerSelectionSalt: `0x${'cc'.repeat(32)}`,
      cumulativeInputTokens: 130n,
      cumulativeCachedInputTokens: 20n,
      cumulativeOutputTokens: 85n,
      cumulativeRequestCount: 3n,
      cumulativeAmountPaid: 90_000n,
    };

    expect(metadataV2MatchesServiceUsage(metadata, usageRows)).toBe(true);
  });
});
