import { Wallet } from 'ethers';
import { describe, expect, it } from 'vitest';
import type { ChannelUsageReportPayload } from '../types/protocol.js';
import { computeCostUsdc } from './pricing.js';
import {
  computeEncodedMetadataHash,
  computeMerkleProof,
  computeMerkleRoot,
  encodeMetadataV2,
  hashReceiptLeaf,
  hashServiceCatalogLeaf,
  hashServiceUsageLeaf,
  hashUtf8,
  makeChannelsDomain,
  SERVICE_MODE_FREE,
  SERVICE_MODE_PAID,
  signSpendingAuth,
  type ReceiptLeaf,
  type ServiceCatalogLeaf,
  type ServiceUsageLeaf,
} from './evm/signatures.js';
import {
  computeUsageReportVerifierSelectionSeed,
  createUsageReportAck,
  getUsageReportVerifierAssignment,
  selectUsageReportVerifiers,
  shouldVerifyUsageReport,
  verifyChannelReportAttestation,
  verifyChannelUsageReport,
} from './usage-report-verifier.js';

const channelId = `0x${'10'.repeat(32)}`;
const channelsAddress = `0x${'99'.repeat(20)}`;
const seller = `0x${'22'.repeat(20)}`;
const sellerAgentId = '42';
const reportedAt = 1_750_000_000;
const selectionBeacon = `0x${'99'.repeat(32)}`;
const verifierCount = 3;

describe('usage-report-verifier', () => {
  it('verifies V2 report leaves, roots, pricing, and buyer SpendingAuth', async () => {
    const buyer = Wallet.createRandom();
    const domain = makeChannelsDomain(8453, channelsAddress);
    const serviceIdHash = hashUtf8('openai:gpt-4.1');
    const catalogLeaf: ServiceCatalogLeaf = {
      sellerAgentId,
      sellerAddress: seller,
      serviceIdHash,
      tokenizerIdHash: hashUtf8('cl100k_base'),
      inputUsdPerMillion: 1_000_000n,
      cachedInputUsdPerMillion: 500_000n,
      outputUsdPerMillion: 2_000_000n,
      serviceMode: SERVICE_MODE_PAID,
      termsHash: hashUtf8('paid terms'),
      validFrom: 1_700_000_000n,
      validUntil: 1_800_000_000n,
    };
    const catalogLeafHash = hashServiceCatalogLeaf(catalogLeaf);
    const catalogRoot = computeMerkleRoot([catalogLeafHash]);
    const costUsdc = computeCostUsdc(100, 10, {
      inputUsdPerMillion: 1_000_000,
      cachedInputUsdPerMillion: 500_000,
      outputUsdPerMillion: 2_000_000,
    }, 20);

    const usageLeaf: ServiceUsageLeaf = {
      channelId,
      serviceIdHash,
      catalogLeafHash,
      serviceMode: SERVICE_MODE_PAID,
      cumulativeFreshInputTokens: 100n,
      cumulativeCachedInputTokens: 20n,
      cumulativeOutputTokens: 10n,
      cumulativeRequestCount: 1n,
      cumulativeAmountPaid: costUsdc,
    };
    const receiptLeaf: ReceiptLeaf = {
      channelId,
      requestIndex: 1n,
      requestIdHash: hashUtf8('request-1'),
      requestHash: `0x${'33'.repeat(32)}`,
      responseHash: `0x${'44'.repeat(32)}`,
      serviceIdHash,
      catalogLeafHash,
      freshInputTokens: 100n,
      cachedInputTokens: 20n,
      outputTokens: 10n,
      costUsdc,
      cumulativeAmountAfterRequest: costUsdc,
    };
    const metadata = {
      catalogRoot,
      usageByServiceRoot: computeMerkleRoot([hashServiceUsageLeaf(usageLeaf)]),
      receiptRoot: computeMerkleRoot([hashReceiptLeaf(receiptLeaf)]),
      cumulativeFreshInputTokens: 100n,
      cumulativeCachedInputTokens: 20n,
      cumulativeOutputTokens: 10n,
      cumulativeRequestCount: 1n,
      cumulativeAmountPaid: costUsdc,
    };
    const encodedMetadata = encodeMetadataV2(metadata);
    const metadataHash = computeEncodedMetadataHash(encodedMetadata);
    const spendingAuthSig = await signSpendingAuth(buyer, domain, {
      channelId,
      cumulativeAmount: costUsdc,
      metadataHash,
    });

    const report: ChannelUsageReportPayload = {
      channelId,
      buyer: buyer.address,
      seller,
      sellerAgentId,
      cumulativeAmount: costUsdc.toString(),
      metadata: encodedMetadata,
      metadataHash,
      selectionBeacon,
      verifierCount,
      buyerSpendingAuthSig: spendingAuthSig,
      catalogRoot,
      sellerCatalogSig: `0x${'55'.repeat(65)}`,
      serviceCatalogLeaves: [toCatalogPayload(catalogLeaf)],
      catalogMerkleProofs: {
        [catalogLeafHash]: computeMerkleProof([catalogLeafHash], catalogLeafHash),
      },
      serviceUsageLeaves: [toUsagePayload(usageLeaf)],
      receiptLeavesOrProofs: [toReceiptPayload(receiptLeaf)],
      reportedAt,
    };

    const result = verifyChannelUsageReport(report, { spendingAuthDomain: domain, settledCumulativeAmount: costUsdc });
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.reportHash).toMatch(/^0x[0-9a-f]{64}$/);

    const verifier = Wallet.createRandom();
    const ack = createUsageReportAck(report, result, {
      verifier: verifier.address,
      verifierAgentId: '77',
      wallet: verifier,
    }, reportedAt + 30);

    expect(ack.accepted).toBe(true);
    expect(ack.attestation?.verifier).toBe(verifier.address.slice(2).toLowerCase());
    expect(ack.attestation ? verifyChannelReportAttestation(ack.attestation) : false).toBe(true);
  });

  it('rejects free service reports with nonzero receipt cost', () => {
    const serviceIdHash = hashUtf8('local:free-demo');
    const catalogLeaf: ServiceCatalogLeaf = {
      sellerAgentId,
      sellerAddress: seller,
      serviceIdHash,
      tokenizerIdHash: hashUtf8('demo-tokenizer'),
      inputUsdPerMillion: 0n,
      cachedInputUsdPerMillion: 0n,
      outputUsdPerMillion: 0n,
      serviceMode: SERVICE_MODE_FREE,
      termsHash: hashUtf8('free terms'),
      validFrom: 1_700_000_000n,
      validUntil: 1_800_000_000n,
    };
    const catalogLeafHash = hashServiceCatalogLeaf(catalogLeaf);
    const usageLeaf: ServiceUsageLeaf = {
      channelId,
      serviceIdHash,
      catalogLeafHash,
      serviceMode: SERVICE_MODE_FREE,
      cumulativeFreshInputTokens: 5n,
      cumulativeCachedInputTokens: 0n,
      cumulativeOutputTokens: 2n,
      cumulativeRequestCount: 1n,
      cumulativeAmountPaid: 1n,
    };
    const receiptLeaf: ReceiptLeaf = {
      channelId,
      requestIndex: 1n,
      requestIdHash: hashUtf8('free-request'),
      requestHash: `0x${'66'.repeat(32)}`,
      responseHash: `0x${'77'.repeat(32)}`,
      serviceIdHash,
      catalogLeafHash,
      freshInputTokens: 5n,
      cachedInputTokens: 0n,
      outputTokens: 2n,
      costUsdc: 1n,
      cumulativeAmountAfterRequest: 1n,
    };
    const catalogRoot = computeMerkleRoot([catalogLeafHash]);
    const encodedMetadata = encodeMetadataV2({
      catalogRoot,
      usageByServiceRoot: computeMerkleRoot([hashServiceUsageLeaf(usageLeaf)]),
      receiptRoot: computeMerkleRoot([hashReceiptLeaf(receiptLeaf)]),
      cumulativeFreshInputTokens: 5n,
      cumulativeCachedInputTokens: 0n,
      cumulativeOutputTokens: 2n,
      cumulativeRequestCount: 1n,
      cumulativeAmountPaid: 1n,
    });
    const metadataHash = computeEncodedMetadataHash(encodedMetadata);

    const result = verifyChannelUsageReport({
      channelId,
      buyer: `0x${'11'.repeat(20)}`,
      seller,
      sellerAgentId,
      cumulativeAmount: '1',
      metadata: encodedMetadata,
      metadataHash,
      selectionBeacon,
      verifierCount,
      catalogRoot,
      sellerCatalogSig: `0x${'55'.repeat(65)}`,
      serviceCatalogLeaves: [toCatalogPayload(catalogLeaf)],
      catalogMerkleProofs: {
        [catalogLeafHash]: computeMerkleProof([catalogLeafHash], catalogLeafHash),
      },
      serviceUsageLeaves: [toUsagePayload(usageLeaf)],
      receiptLeavesOrProofs: [toReceiptPayload(receiptLeaf)],
      reportedAt,
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('free-usage-paid-amount');
    expect(result.issues.map((issue) => issue.code)).toContain('free-receipt-cost');

    const verifier = Wallet.createRandom();
    const ack = createUsageReportAck({
      channelId,
      buyer: `0x${'11'.repeat(20)}`,
      seller,
      sellerAgentId,
      cumulativeAmount: '1',
      metadata: encodedMetadata,
      metadataHash,
      selectionBeacon,
      verifierCount,
      catalogRoot,
      sellerCatalogSig: `0x${'55'.repeat(65)}`,
      serviceCatalogLeaves: [toCatalogPayload(catalogLeaf)],
      catalogMerkleProofs: {
        [catalogLeafHash]: computeMerkleProof([catalogLeafHash], catalogLeafHash),
      },
      serviceUsageLeaves: [toUsagePayload(usageLeaf)],
      receiptLeavesOrProofs: [toReceiptPayload(receiptLeaf)],
      reportedAt,
    }, result, {
      verifier: verifier.address,
      verifierAgentId: '77',
      wallet: verifier,
    });
    expect(ack.accepted).toBe(false);
    expect(ack.attestation).toBeUndefined();
  });

  it('selects verifier sellers deterministically from eligible candidates', () => {
    const report = {
      channelId,
      metadataHash: `0x${'88'.repeat(32)}`,
      buyer: address(1),
      seller,
      sellerAgentId,
      selectionBeacon,
      verifierCount,
    };
    const candidates = [
      { peerId: report.buyer, agentId: '1', staked: true, stakeWeight: 100n, firstSeenAt: 1_000, verificationCountForSeller: 0 },
      { peerId: seller, agentId: '2', staked: true, stakeWeight: 100n, firstSeenAt: 1_000, verificationCountForSeller: 0 },
      { peerId: address(3), agentId: sellerAgentId, staked: true, stakeWeight: 100n, firstSeenAt: 1_000, verificationCountForSeller: 0 },
      { peerId: address(4), agentId: '4', staked: false, stakeWeight: 100n, firstSeenAt: 1_000, verificationCountForSeller: 0 },
      { peerId: address(5), agentId: '5', staked: true, stakeWeight: 0n, firstSeenAt: 1_000, verificationCountForSeller: 0 },
      { peerId: address(6), agentId: '6', staked: true, stakeWeight: 100n, firstSeenAt: 9_950, verificationCountForSeller: 0 },
      { peerId: address(7), agentId: '7', staked: true, stakeWeight: 100n, firstSeenAt: 1_000, verificationCountForSeller: 3 },
      { peerId: address(8), agentId: '8', staked: true, stakeWeight: 100n, firstSeenAt: 1_000, verificationCountForSeller: 0 },
      { peerId: address(9), agentId: '9', staked: true, stakeWeight: 250n, firstSeenAt: 1_000, verificationCountForSeller: 0 },
      { peerId: address(10), agentId: '10', staked: true, stakeWeight: 100n, firstSeenAt: 1_000, verificationCountForSeller: 0 },
      { peerId: address(11), agentId: '11', staked: true, stakeWeight: 100n, firstSeenAt: 1_000, verificationCountForSeller: 0 },
    ];

    const options = {
      verifierCount: 3,
      selectionBeacon,
      minStakeWeight: 1n,
      minAgeSeconds: 1_000,
      now: 10_000,
      maxVerificationsForSeller: 3,
    };
    const selected = selectUsageReportVerifiers(report, candidates, options);
    const selectedFromReversed = selectUsageReportVerifiers(report, [...candidates].reverse(), options);

    expect(selected).toHaveLength(3);
    expect(selected.map((candidate) => candidate.peerId)).toEqual(selectedFromReversed.map((candidate) => candidate.peerId));
    expect(selected.map((candidate) => candidate.rank)).toEqual([1, 2, 3]);
    expect(selected.some((candidate) => candidate.peerId.toLowerCase() === report.buyer.toLowerCase())).toBe(false);
    expect(selected.some((candidate) => candidate.peerId.toLowerCase() === report.seller.toLowerCase())).toBe(false);
    expect(selected.some((candidate) => candidate.agentId === sellerAgentId)).toBe(false);
    expect(selected.every((candidate) => BigInt(candidate.selectionScore) >= 0n)).toBe(true);

    const seed = computeUsageReportVerifierSelectionSeed(report, selectionBeacon);
    expect(selected.every((candidate) => candidate.selectionSeed === seed)).toBe(true);

    const differentMetadataSeed = computeUsageReportVerifierSelectionSeed({
      ...report,
      metadataHash: `0x${'89'.repeat(32)}`,
    }, selectionBeacon);
    const differentBeaconSeed = computeUsageReportVerifierSelectionSeed(report, `0x${'98'.repeat(32)}`);
    expect(differentMetadataSeed).not.toBe(seed);
    expect(differentBeaconSeed).not.toBe(seed);
  });

  it('lets a seller determine whether it should verify a received report', () => {
    const report = {
      channelId,
      metadataHash: `0x${'88'.repeat(32)}`,
      buyer: address(1),
      seller,
      sellerAgentId,
      selectionBeacon,
      verifierCount: 2,
    };
    const candidates = [
      { peerId: address(8), agentId: '8', staked: true, stakeWeight: 100n, firstSeenAt: 1_000 },
      { peerId: address(9), agentId: '9', staked: true, stakeWeight: 250n, firstSeenAt: 1_000 },
      { peerId: address(10), agentId: '10', staked: true, stakeWeight: 100n, firstSeenAt: 1_000 },
      { peerId: address(11), agentId: '11', staked: true, stakeWeight: 100n, firstSeenAt: 1_000 },
    ];

    const selected = selectUsageReportVerifiers(report, candidates, {
      selectionBeacon,
      verifierCount: report.verifierCount,
      minAgeSeconds: 1_000,
      now: 10_000,
    });
    const assignment = getUsageReportVerifierAssignment(report, candidates, {
      peerId: selected[0]!.peerId,
      agentId: selected[0]!.agentId,
    }, {
      minAgeSeconds: 1_000,
      now: 10_000,
    });

    expect(assignment?.rank).toBe(selected[0]!.rank);
    expect(shouldVerifyUsageReport(report, candidates, {
      peerId: selected[0]!.peerId,
      agentId: selected[0]!.agentId,
    }, {
      minAgeSeconds: 1_000,
      now: 10_000,
    })).toBe(true);
    expect(shouldVerifyUsageReport(report, candidates, { peerId: address(12), agentId: '12' }, {
      minAgeSeconds: 1_000,
      now: 10_000,
    })).toBe(false);
  });
});

function toCatalogPayload(leaf: ServiceCatalogLeaf) {
  return {
    sellerAgentId: leaf.sellerAgentId.toString(),
    sellerAddress: leaf.sellerAddress,
    serviceIdHash: leaf.serviceIdHash,
    tokenizerIdHash: leaf.tokenizerIdHash,
    inputUsdPerMillion: leaf.inputUsdPerMillion.toString(),
    cachedInputUsdPerMillion: leaf.cachedInputUsdPerMillion.toString(),
    outputUsdPerMillion: leaf.outputUsdPerMillion.toString(),
    serviceMode: leaf.serviceMode.toString(),
    termsHash: leaf.termsHash,
    validFrom: leaf.validFrom.toString(),
    validUntil: leaf.validUntil.toString(),
  };
}

function toUsagePayload(leaf: ServiceUsageLeaf) {
  return {
    channelId: leaf.channelId,
    serviceIdHash: leaf.serviceIdHash,
    catalogLeafHash: leaf.catalogLeafHash,
    serviceMode: leaf.serviceMode.toString(),
    cumulativeFreshInputTokens: leaf.cumulativeFreshInputTokens.toString(),
    cumulativeCachedInputTokens: leaf.cumulativeCachedInputTokens.toString(),
    cumulativeOutputTokens: leaf.cumulativeOutputTokens.toString(),
    cumulativeRequestCount: leaf.cumulativeRequestCount.toString(),
    cumulativeAmountPaid: leaf.cumulativeAmountPaid.toString(),
  };
}

function toReceiptPayload(leaf: ReceiptLeaf) {
  return {
    channelId: leaf.channelId,
    requestIndex: leaf.requestIndex.toString(),
    requestIdHash: leaf.requestIdHash,
    requestHash: leaf.requestHash,
    responseHash: leaf.responseHash,
    serviceIdHash: leaf.serviceIdHash,
    catalogLeafHash: leaf.catalogLeafHash,
    freshInputTokens: leaf.freshInputTokens.toString(),
    cachedInputTokens: leaf.cachedInputTokens.toString(),
    outputTokens: leaf.outputTokens.toString(),
    costUsdc: leaf.costUsdc.toString(),
    cumulativeAmountAfterRequest: leaf.cumulativeAmountAfterRequest.toString(),
  };
}

function address(n: number): string {
  return `0x${n.toString(16).padStart(40, '0')}`;
}
