import { Wallet } from 'ethers';
import { describe, expect, it } from 'vitest';
import type { PeerMetadata } from '../discovery/peer-metadata.js';
import { encodeMetadataForSigning } from '../discovery/metadata-codec.js';
import { signData } from '../p2p/identity.js';
import type { PeerId } from '../types/peer.js';
import type { ChannelUsageReportPayload } from '../types/protocol.js';
import { bytesToHex } from '../utils/hex.js';
import { computeCostUsdc } from './pricing.js';
import {
  computeEncodedMetadataHash,
  computeMerkleRoot,
  encodeMetadataV2,
  hashServiceUsageLeaf,
  makeChannelsDomain,
  SERVICE_MODE_PAID,
  signSpendingAuth,
  ZERO_BYTES32,
  type ServiceUsageLeaf,
} from './evm/signatures.js';
import {
  computeUsageReportVerifierSelectionSeed,
  createUsageReportAck,
  derivePricingSnapshotHash,
  getUsageReportVerifierAssignment,
  selectUsageReportVerifiers,
  serviceIdHash,
  shouldVerifyUsageReport,
  verifyChannelReportAttestation,
  verifyChannelUsageReport,
} from './usage-report-verifier.js';

const channelId = `0x${'10'.repeat(32)}`;
const channelsAddress = `0x${'99'.repeat(20)}`;
const sellerWallet = new Wallet(`0x${'22'.repeat(32)}`);
const seller = sellerWallet.address;
const sellerAgentId = '42';
const reportedAt = 1_750_000_000;
const selectionBeacon = `0x${'99'.repeat(32)}`;
const verifierCount = 3;

describe('usage-report-verifier', () => {
  it('verifies cumulative service rows against announced metadata pricing and buyer SpendingAuth', async () => {
    const { report, domain, costUsdc, sellerMetadata } = await createValidPaidReport();

    const result = verifyChannelUsageReport(report, {
      spendingAuthDomain: domain,
      settledCumulativeAmount: costUsdc,
      sellerMetadata,
    });
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
    expect(ack.attestation?.pricingSnapshotHash).toBe(report.pricingSnapshotHash);
    expect(ack.attestation ? verifyChannelReportAttestation(ack.attestation) : false).toBe(true);
  });

  it('returns verification issues instead of throwing for malformed peer report fields', async () => {
    const { report, domain, costUsdc, sellerMetadata } = await createValidPaidReport();

    const result = verifyChannelUsageReport({
      ...report,
      sellerAgentId: 'x',
    }, { spendingAuthDomain: domain, settledCumulativeAmount: costUsdc, sellerMetadata });

    expect(result.ok).toBe(false);
    expect(result.reportHash).toBe(ZERO_BYTES32);
    expect(result.issues.map((issue) => issue.code)).toContain('invalid-report-field');
  });

  it('rejects service rows whose paid amount does not match announced pricing', async () => {
    const { report, domain, costUsdc, sellerMetadata } = await createValidPaidReport();

    const result = verifyChannelUsageReport({
      ...report,
      serviceUsageLeaves: [{
        ...report.serviceUsageLeaves[0]!,
        cumulativeAmountPaid: (costUsdc + 1n).toString(),
      }],
    }, { spendingAuthDomain: domain, settledCumulativeAmount: costUsdc + 1n, sellerMetadata });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('usage-root-or-total-mismatch');
    expect(result.issues.map((issue) => issue.code)).toContain('announced-pricing-cost-mismatch');
  });

  it('rejects service rows whose on-chain pricing does not match announced metadata pricing', async () => {
    const { report, domain, costUsdc, sellerMetadata } = await createValidPaidReport();

    const result = verifyChannelUsageReport({
      ...report,
      serviceUsageLeaves: [{
        ...report.serviceUsageLeaves[0]!,
        inputUsdPerMillion: '999999',
      }],
    }, { spendingAuthDomain: domain, settledCumulativeAmount: costUsdc, sellerMetadata });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('usage-root-or-total-mismatch');
    expect(result.issues.map((issue) => issue.code)).toContain('usage-pricing-mismatch');
  });

  it('rejects reports when the seller metadata pricing snapshot is unavailable', async () => {
    const { report, domain, costUsdc } = await createValidPaidReport();

    const result = verifyChannelUsageReport(report, {
      spendingAuthDomain: domain,
      settledCumulativeAmount: costUsdc,
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('missing-seller-metadata');
  });

  it('rejects reports when seller metadata is not signed by the seller peer', async () => {
    const { report, domain, costUsdc, sellerMetadata } = await createValidPaidReport();

    const result = verifyChannelUsageReport(report, {
      spendingAuthDomain: domain,
      settledCumulativeAmount: costUsdc,
      sellerMetadata: { ...sellerMetadata, signature: '00'.repeat(65) },
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('invalid-seller-metadata-signature');
  });

  it('selects deterministic eligible verifiers', () => {
    const report = {
      channelId,
      metadataHash: `0x${'88'.repeat(32)}`,
      buyer: address(1),
      seller,
      sellerAgentId,
      selectionBeacon,
      verifierCount: 3,
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

async function createValidPaidReport(): Promise<{
  report: ChannelUsageReportPayload;
  sellerMetadata: PeerMetadata;
  domain: ReturnType<typeof makeChannelsDomain>;
  costUsdc: bigint;
}> {
  const buyer = Wallet.createRandom();
  const domain = makeChannelsDomain(8453, channelsAddress);
  const sellerMetadata = createSellerMetadata();
  const pricingSnapshotHash = derivePricingSnapshotHash(sellerMetadata);
  const costUsdc = computeCostUsdc(100, 10, {
    inputUsdPerMillion: 1_000_000,
    cachedInputUsdPerMillion: 500_000,
    outputUsdPerMillion: 2_000_000,
  }, 20);
  const usageLeaf: ServiceUsageLeaf = {
    channelId,
    provider: 'openai',
    service: 'gpt-4.1',
    serviceIdHash: serviceIdHash('openai', 'gpt-4.1'),
    inputUsdPerMillion: 1_000_000n,
    cachedInputUsdPerMillion: 500_000n,
    outputUsdPerMillion: 2_000_000n,
    serviceMode: SERVICE_MODE_PAID,
    cumulativeFreshInputTokens: 100n,
    cumulativeCachedInputTokens: 20n,
    cumulativeOutputTokens: 10n,
    cumulativeRequestCount: 1n,
    cumulativeAmountPaid: costUsdc,
  };
  const metadata = {
    pricingSnapshotHash,
    usageByServiceRoot: computeMerkleRoot([hashServiceUsageLeaf(usageLeaf)]),
    receiptRoot: ZERO_BYTES32,
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

  return {
    domain,
    sellerMetadata,
    costUsdc,
    report: {
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
      pricingSnapshotHash,
      serviceUsageLeaves: [toUsagePayload(usageLeaf)],
      reportedAt,
    },
  };
}

function createSellerMetadata(): PeerMetadata {
  const metadata: PeerMetadata = {
    peerId: seller.slice(2).toLowerCase() as PeerId,
    version: 8,
    providers: [{
      provider: 'openai',
      services: ['gpt-4.1'],
      defaultPricing: {
        inputUsdPerMillion: 1_000_000,
        cachedInputUsdPerMillion: 500_000,
        outputUsdPerMillion: 2_000_000,
      },
      maxConcurrency: 5,
      currentLoad: 0,
    }],
    region: 'test',
    timestamp: reportedAt * 1000,
    signature: '',
  };
  metadata.signature = bytesToHex(signData(sellerWallet, encodeMetadataForSigning(metadata)));
  return metadata;
}

function toUsagePayload(leaf: ServiceUsageLeaf) {
  return {
    channelId: leaf.channelId,
    provider: leaf.provider,
    service: leaf.service,
    serviceIdHash: leaf.serviceIdHash,
    inputUsdPerMillion: leaf.inputUsdPerMillion.toString(),
    cachedInputUsdPerMillion: leaf.cachedInputUsdPerMillion.toString(),
    outputUsdPerMillion: leaf.outputUsdPerMillion.toString(),
    serviceMode: leaf.serviceMode.toString(),
    cumulativeFreshInputTokens: leaf.cumulativeFreshInputTokens.toString(),
    cumulativeCachedInputTokens: leaf.cumulativeCachedInputTokens.toString(),
    cumulativeOutputTokens: leaf.cumulativeOutputTokens.toString(),
    cumulativeRequestCount: leaf.cumulativeRequestCount.toString(),
    cumulativeAmountPaid: leaf.cumulativeAmountPaid.toString(),
  };
}

function address(n: number): string {
  return `0x${n.toString(16).padStart(40, '0')}`;
}
