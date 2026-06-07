import { describe, expect, it } from 'vitest';
import {
  SERVICE_MODE_FREE,
  SERVICE_MODE_PAID,
  ZERO_BYTES32,
  computeEncodedMetadataHash,
  computeMerkleProof,
  computeMerkleRoot,
  decodeMetadata,
  encodeMetadata,
  encodeMetadataV2,
  hashReceiptLeaf,
  hashServiceCatalogLeaf,
  hashServiceUsageLeaf,
  hashUtf8,
  metadataV2MatchesServiceUsage,
  verifyMerkleProof,
  type ServiceUsageLeaf,
  type SpendingAuthMetadataV2,
} from './signatures.js';

const channelId = `0x${'11'.repeat(32)}`;
const seller = `0x${'22'.repeat(20)}`;
const requestHash = `0x${'33'.repeat(32)}`;
const responseHash = `0x${'44'.repeat(32)}`;

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

  it('encodes and decodes V2 metadata with roots and split input totals', () => {
    const metadata: SpendingAuthMetadataV2 = {
      pricingSnapshotHash: `0x${'aa'.repeat(32)}`,
      usageByServiceRoot: `0x${'bb'.repeat(32)}`,
      receiptRoot: `0x${'cc'.repeat(32)}`,
      cumulativeFreshInputTokens: 100n,
      cumulativeCachedInputTokens: 25n,
      cumulativeOutputTokens: 50n,
      cumulativeRequestCount: 3n,
      cumulativeAmountPaid: 12_345n,
    };

    const encoded = encodeMetadataV2(metadata);
    expect(computeEncodedMetadataHash(encoded)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(decodeMetadata(encoded)).toEqual({ version: 2n, ...metadata });
  });

  it('builds verifiable catalog, usage, and receipt roots', () => {
    const serviceIdHash = hashUtf8('openai:gpt-4.1');
    const tokenizerIdHash = hashUtf8('cl100k_base');
    const termsHash = hashUtf8('standard paid terms');
    const catalogLeafHash = hashServiceCatalogLeaf({
      sellerAgentId: 42n,
      sellerAddress: seller,
      serviceIdHash,
      tokenizerIdHash,
      inputUsdPerMillion: 2_000_000n,
      cachedInputUsdPerMillion: 500_000n,
      outputUsdPerMillion: 8_000_000n,
      serviceMode: SERVICE_MODE_PAID,
      termsHash,
      validFrom: 1_700_000_000n,
      validUntil: 1_800_000_000n,
    });
    const freeCatalogLeafHash = hashServiceCatalogLeaf({
      sellerAgentId: 42n,
      sellerAddress: seller,
      serviceIdHash: hashUtf8('local:free-demo'),
      tokenizerIdHash,
      inputUsdPerMillion: 0n,
      cachedInputUsdPerMillion: 0n,
      outputUsdPerMillion: 0n,
      serviceMode: SERVICE_MODE_FREE,
      termsHash: hashUtf8('free demo terms'),
      validFrom: 1_700_000_000n,
      validUntil: 1_800_000_000n,
    });

    const catalogRoot = computeMerkleRoot([catalogLeafHash, freeCatalogLeafHash]);
    const proof = computeMerkleProof([catalogLeafHash, freeCatalogLeafHash], catalogLeafHash);
    expect(verifyMerkleProof(catalogLeafHash, proof, catalogRoot)).toBe(true);
    expect(computeMerkleRoot([])).toBe(ZERO_BYTES32);

    const usageLeaves: ServiceUsageLeaf[] = [
      {
        channelId,
        provider: 'openai',
        service: 'gpt-4.1',
        serviceIdHash,
        inputUsdPerMillion: 2_000_000n,
        cachedInputUsdPerMillion: 500_000n,
        outputUsdPerMillion: 8_000_000n,
        serviceMode: SERVICE_MODE_PAID,
        cumulativeFreshInputTokens: 120n,
        cumulativeCachedInputTokens: 20n,
        cumulativeOutputTokens: 80n,
        cumulativeRequestCount: 2n,
        cumulativeAmountPaid: 90_000n,
      },
      {
        channelId,
        provider: 'local',
        service: 'free-demo',
        serviceIdHash: hashUtf8('local:free-demo'),
        inputUsdPerMillion: 0n,
        cachedInputUsdPerMillion: 0n,
        outputUsdPerMillion: 0n,
        serviceMode: SERVICE_MODE_FREE,
        cumulativeFreshInputTokens: 10n,
        cumulativeCachedInputTokens: 0n,
        cumulativeOutputTokens: 5n,
        cumulativeRequestCount: 1n,
        cumulativeAmountPaid: 0n,
      },
    ];

    const metadata: SpendingAuthMetadataV2 = {
      pricingSnapshotHash: catalogRoot,
      usageByServiceRoot: computeMerkleRoot(usageLeaves.map(hashServiceUsageLeaf)),
      receiptRoot: computeMerkleRoot([
        hashReceiptLeaf({
          channelId,
          requestIndex: 1n,
          requestIdHash: hashUtf8('req-1'),
          requestHash,
          responseHash,
          serviceIdHash,
          catalogLeafHash,
          freshInputTokens: 120n,
          cachedInputTokens: 20n,
          outputTokens: 80n,
          costUsdc: 90_000n,
          cumulativeAmountAfterRequest: 90_000n,
        }),
      ]),
      cumulativeFreshInputTokens: 130n,
      cumulativeCachedInputTokens: 20n,
      cumulativeOutputTokens: 85n,
      cumulativeRequestCount: 3n,
      cumulativeAmountPaid: 90_000n,
    };

    expect(metadataV2MatchesServiceUsage(metadata, usageLeaves)).toBe(true);
  });
});
