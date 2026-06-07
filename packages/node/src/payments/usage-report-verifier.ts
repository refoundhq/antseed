import { AbiCoder, isAddress, keccak256, type TypedDataDomain, verifyTypedData, type Wallet } from 'ethers';
import type {
  ChannelReportAttestationPayload,
  ChannelUsageReportCatalogLeafPayload,
  ChannelUsageReportPayload,
  ChannelUsageReportReceiptLeafPayload,
  ChannelUsageReportServiceUsageLeafPayload,
  UsageReportAckPayload,
} from '../types/protocol.js';
import { computeCostUsdc } from './pricing.js';
import { signUtf8, verifyUtf8 } from '../p2p/identity.js';
import {
  computeEncodedMetadataHash,
  computeMerkleRoot,
  decodeMetadata,
  hashReceiptLeaf,
  hashServiceCatalogLeaf,
  hashServiceUsageLeaf,
  metadataV2MatchesServiceUsage,
  SERVICE_MODE_FREE,
  SERVICE_MODE_PAID,
  SPENDING_AUTH_TYPES,
  verifyMerkleProof,
  ZERO_BYTES32,
  type ReceiptLeaf,
  type ServiceCatalogLeaf,
  type ServiceUsageLeaf,
  type SpendingAuthMetadataV2,
} from './evm/signatures.js';

export interface UsageReportVerificationIssue {
  code: string;
  message: string;
}

export interface UsageReportVerificationResult {
  ok: boolean;
  reportHash: string;
  metadata: SpendingAuthMetadataV2 | null;
  issues: UsageReportVerificationIssue[];
}

export interface UsageReportVerifierIdentity {
  verifier: string;
  verifierAgentId: string;
  wallet: Wallet;
}

export interface UsageReportVerifierCandidate {
  /** Seller peer wallet / peerId. Accepts 0x-prefixed address or 40-char peerId. */
  peerId: string;
  agentId: string;
  /** False candidates are ignored. Defaults to true. */
  staked?: boolean;
  /** Relative deterministic weight. Defaults to 1. */
  stakeWeight?: bigint | string | number;
  /** Optional identity age gate for Sybil resistance. */
  firstSeenAt?: number;
  /** Optional local anti-overuse counter for this seller/reporting peer. */
  verificationCountForSeller?: number;
}

export interface UsageReportLocalVerifier {
  peerId: string;
  agentId: string;
}

export interface SelectedUsageReportVerifier extends UsageReportVerifierCandidate {
  rank: number;
  selectionSeed: string;
  selectionScore: string;
}

export interface UsageReportVerifierSelectionOptions {
  verifierCount: number;
  /** Recent block hash, beacon output, or another unpredictable public bytes32. */
  selectionBeacon: string;
  minStakeWeight?: bigint | string | number;
  minAgeSeconds?: number;
  now?: number;
  maxVerificationsForSeller?: number;
}

export type UsageReportVerifierAssignmentOptions = Omit<UsageReportVerifierSelectionOptions, 'verifierCount' | 'selectionBeacon'>;

export interface UsageReportVerifierOptions {
  /**
   * Required to verify paid reports. Use makeChannelsDomain(chainId, channels).
   * Free reports with zero paid amount do not need buyer authorization.
   */
  spendingAuthDomain?: TypedDataDomain;
  /**
   * Optional chain/indexer observation. When provided, paid reports must not
   * claim more paid amount than the compatible on-chain channel state.
   */
  settledCumulativeAmount?: bigint | string;
}

export function computeUsageReportVerifierSelectionSeed(
  report: Pick<ChannelUsageReportPayload, 'channelId' | 'metadataHash'>,
  selectionBeacon: string,
): string {
  const coder = AbiCoder.defaultAbiCoder();
  return keccak256(coder.encode(
    ['bytes32', 'bytes32', 'bytes32'],
    [report.channelId, report.metadataHash, selectionBeacon],
  ));
}

export function selectUsageReportVerifiers(
  report: Pick<ChannelUsageReportPayload, 'channelId' | 'metadataHash' | 'buyer' | 'seller' | 'sellerAgentId'>,
  candidates: readonly UsageReportVerifierCandidate[],
  options: UsageReportVerifierSelectionOptions,
): SelectedUsageReportVerifier[] {
  if (options.verifierCount <= 0) return [];

  const seed = computeUsageReportVerifierSelectionSeed(report, options.selectionBeacon);
  const minStakeWeight = toBigInt(options.minStakeWeight ?? 1n);
  const now = options.now ?? Math.floor(Date.now() / 1000);

  return candidates
    .filter((candidate) => isEligibleVerifierCandidate(report, candidate, {
      minStakeWeight,
      minAgeSeconds: options.minAgeSeconds,
      now,
      maxVerificationsForSeller: options.maxVerificationsForSeller,
    }))
    .map((candidate) => {
      const rawScore = computeVerifierCandidateScore(seed, candidate);
      const stakeWeight = toBigInt(candidate.stakeWeight ?? 1n);
      const weightedScore = rawScore / (stakeWeight > 0n ? stakeWeight : 1n);
      return {
        ...candidate,
        selectionSeed: seed,
        selectionScore: weightedScore.toString(),
      };
    })
    .sort((a, b) => {
      const scoreDiff = BigInt(a.selectionScore) - BigInt(b.selectionScore);
      if (scoreDiff < 0n) return -1;
      if (scoreDiff > 0n) return 1;
      const agentDiff = BigInt(a.agentId) - BigInt(b.agentId);
      if (agentDiff < 0n) return -1;
      if (agentDiff > 0n) return 1;
      return normalizeAddress(a.peerId).localeCompare(normalizeAddress(b.peerId));
    })
    .slice(0, options.verifierCount)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

export function getUsageReportVerifierAssignment(
  report: Pick<ChannelUsageReportPayload, 'channelId' | 'metadataHash' | 'buyer' | 'seller' | 'sellerAgentId' | 'selectionBeacon' | 'verifierCount'>,
  candidates: readonly UsageReportVerifierCandidate[],
  verifier: UsageReportLocalVerifier,
  options: UsageReportVerifierAssignmentOptions = {},
): SelectedUsageReportVerifier | null {
  const selected = selectUsageReportVerifiers(report, candidates, {
    ...options,
    selectionBeacon: report.selectionBeacon,
    verifierCount: report.verifierCount,
  });
  const verifierPeer = normalizeAddress(verifier.peerId);
  const verifierAgentId = BigInt(verifier.agentId);
  return selected.find((candidate) =>
    normalizeAddress(candidate.peerId) === verifierPeer && BigInt(candidate.agentId) === verifierAgentId
  ) ?? null;
}

export function shouldVerifyUsageReport(
  report: Pick<ChannelUsageReportPayload, 'channelId' | 'metadataHash' | 'buyer' | 'seller' | 'sellerAgentId' | 'selectionBeacon' | 'verifierCount'>,
  candidates: readonly UsageReportVerifierCandidate[],
  verifier: UsageReportLocalVerifier,
  options: UsageReportVerifierAssignmentOptions = {},
): boolean {
  return getUsageReportVerifierAssignment(report, candidates, verifier, options) !== null;
}

export function computeChannelUsageReportHash(report: ChannelUsageReportPayload): string {
  const coder = AbiCoder.defaultAbiCoder();
  return keccak256(coder.encode(
    [
      'bytes32',
      'address',
      'address',
      'uint256',
      'uint256',
      'bytes32',
      'bytes32',
      'bytes32',
      'bytes32',
      'uint256',
      'bytes32',
      'uint256',
    ],
    [
      report.channelId,
      report.buyer,
      report.seller,
      BigInt(report.sellerAgentId),
      BigInt(report.cumulativeAmount),
      report.metadataHash,
      report.catalogRoot,
      computeMerkleRoot(report.serviceUsageLeaves.map((leaf) => hashServiceUsageLeaf(fromServiceUsagePayload(leaf)))),
      computeMerkleRoot(report.receiptLeavesOrProofs.map((leaf) => hashReceiptLeaf(fromReceiptPayload(leaf)))),
      BigInt(report.reportedAt),
      report.selectionBeacon,
      BigInt(report.verifierCount),
    ],
  ));
}

export function verifyChannelUsageReport(
  report: ChannelUsageReportPayload,
  options: UsageReportVerifierOptions = {},
): UsageReportVerificationResult {
  const issues: UsageReportVerificationIssue[] = [];
  const addIssue = (code: string, message: string) => issues.push({ code, message });

  validateReportFields(report, addIssue);
  if (issues.length > 0) {
    return {
      ok: false,
      reportHash: ZERO_BYTES32,
      metadata: null,
      issues,
    };
  }

  let reportHash = ZERO_BYTES32;
  try {
    reportHash = computeChannelUsageReportHash(report);
  } catch (err) {
    addIssue('invalid-report-field', err instanceof Error ? err.message : String(err));
    return {
      ok: false,
      reportHash,
      metadata: null,
      issues,
    };
  }

  if (computeEncodedMetadataHash(report.metadata).toLowerCase() !== report.metadataHash.toLowerCase()) {
    addIssue('metadata-hash-mismatch', 'metadataHash does not match keccak256(metadata)');
  }

  if (!verifySellerCatalogSignature(report)) {
    addIssue('invalid-seller-catalog-signature', 'sellerCatalogSig does not recover the report seller');
  }

  let metadata: SpendingAuthMetadataV2 | null = null;
  try {
    const decoded = decodeMetadata(report.metadata);
    if (decoded.version !== 2n) {
      addIssue('unsupported-metadata-version', 'channel usage reports require V2 metadata');
    } else {
      metadata = decoded;
    }
  } catch (err) {
    addIssue('metadata-decode-failed', err instanceof Error ? err.message : String(err));
  }

  const catalogLeaves = report.serviceCatalogLeaves.map(fromCatalogPayload);
  const catalogLeafHashes = new Map<string, ServiceCatalogLeaf>();
  for (const leaf of catalogLeaves) {
    const leafHash = hashServiceCatalogLeaf(leaf);
    catalogLeafHashes.set(leafHash.toLowerCase(), leaf);
    const proof = report.catalogMerkleProofs[leafHash] ?? report.catalogMerkleProofs[leafHash.toLowerCase()];
    if (!proof) {
      addIssue('missing-catalog-proof', `catalog leaf ${leafHash} is missing a Merkle proof`);
    } else if (!verifyMerkleProof(leafHash, proof, report.catalogRoot)) {
      addIssue('invalid-catalog-proof', `catalog leaf ${leafHash} is not included in catalogRoot`);
    }
    if (leaf.sellerAddress.toLowerCase() !== report.seller.toLowerCase()) {
      addIssue('catalog-seller-mismatch', `catalog leaf ${leafHash} seller does not match report seller`);
    }
    if (toBigInt(leaf.sellerAgentId) !== BigInt(report.sellerAgentId)) {
      addIssue('catalog-agent-mismatch', `catalog leaf ${leafHash} sellerAgentId does not match report sellerAgentId`);
    }
    const reportedAt = BigInt(report.reportedAt);
    if (reportedAt < toBigInt(leaf.validFrom) || reportedAt > toBigInt(leaf.validUntil)) {
      addIssue('catalog-window-mismatch', `catalog leaf ${leafHash} validity window does not cover reportedAt`);
    }
  }

  const usageLeaves = report.serviceUsageLeaves.map(fromServiceUsagePayload);
  const receiptLeaves = report.receiptLeavesOrProofs.map(fromReceiptPayload);

  if (metadata) {
    if (metadata.catalogRoot.toLowerCase() !== report.catalogRoot.toLowerCase()) {
      addIssue('catalog-root-mismatch', 'report catalogRoot does not match metadata catalogRoot');
    }
    if (!metadataV2MatchesServiceUsage(metadata, usageLeaves)) {
      addIssue('usage-root-or-total-mismatch', 'usageByServiceRoot or usage totals do not match service usage leaves');
    }
    const receiptRoot = computeMerkleRoot(receiptLeaves.map(hashReceiptLeaf));
    if (receiptRoot.toLowerCase() !== metadata.receiptRoot.toLowerCase()) {
      addIssue('receipt-root-mismatch', 'receiptRoot does not match receipt leaves');
    }
  }

  verifyUsageLeaves(report, usageLeaves, catalogLeafHashes, addIssue);
  verifyReceipts(report, usageLeaves, receiptLeaves, catalogLeafHashes, addIssue);
  verifyPaidAuthorization(report, metadata, options, addIssue);

  return {
    ok: issues.length === 0,
    reportHash,
    metadata,
    issues,
  };
}

export function createChannelReportAttestation(
  report: ChannelUsageReportPayload,
  verification: UsageReportVerificationResult,
  verifierIdentity: UsageReportVerifierIdentity,
  timestamp = Math.floor(Date.now() / 1000),
): ChannelReportAttestationPayload {
  if (!verification.ok || !verification.metadata) {
    throw new Error('Cannot attest to an invalid channel usage report');
  }

  const attestation: Omit<ChannelReportAttestationPayload, 'signature'> = {
    channelId: report.channelId,
    reportHash: verification.reportHash,
    seller: report.seller,
    sellerAgentId: report.sellerAgentId,
    buyer: report.buyer,
    cumulativeAmount: report.cumulativeAmount,
    metadataHash: report.metadataHash,
    catalogRoot: verification.metadata.catalogRoot,
    usageByServiceRoot: verification.metadata.usageByServiceRoot,
    verifier: normalizeAddress(verifierIdentity.verifier),
    verifierAgentId: verifierIdentity.verifierAgentId,
    timestamp,
  };

  return {
    ...attestation,
    signature: signUtf8(verifierIdentity.wallet, encodeAttestationForSigning(attestation)),
  };
}

export function createUsageReportAck(
  report: ChannelUsageReportPayload,
  verification: UsageReportVerificationResult,
  verifierIdentity: UsageReportVerifierIdentity,
  timestamp = Math.floor(Date.now() / 1000),
): UsageReportAckPayload {
  if (!verification.ok) {
    return {
      channelId: report.channelId,
      reportHash: verification.reportHash,
      verifierAgentId: verifierIdentity.verifierAgentId,
      accepted: false,
      reason: verification.issues.map((issue) => issue.code).join(','),
    };
  }

  return {
    channelId: report.channelId,
    reportHash: verification.reportHash,
    verifierAgentId: verifierIdentity.verifierAgentId,
    accepted: true,
    attestation: createChannelReportAttestation(report, verification, verifierIdentity, timestamp),
  };
}

export function verifyChannelReportAttestation(attestation: ChannelReportAttestationPayload): boolean {
  const { signature, ...signedFields } = attestation;
  return verifyUtf8(normalizeAddress(attestation.verifier), encodeAttestationForSigning(signedFields), stripHexPrefix(signature));
}

export function encodeAttestationForSigning(attestation: Omit<ChannelReportAttestationPayload, 'signature'>): string {
  return JSON.stringify({
    type: 'AntseedChannelReportAttestation',
    version: 1,
    channelId: attestation.channelId,
    reportHash: attestation.reportHash,
    seller: normalizeAddress(attestation.seller),
    sellerAgentId: attestation.sellerAgentId,
    buyer: normalizeAddress(attestation.buyer),
    cumulativeAmount: attestation.cumulativeAmount,
    metadataHash: attestation.metadataHash,
    catalogRoot: attestation.catalogRoot,
    usageByServiceRoot: attestation.usageByServiceRoot,
    verifier: normalizeAddress(attestation.verifier),
    verifierAgentId: attestation.verifierAgentId,
    timestamp: attestation.timestamp,
  });
}

export function encodeSellerCatalogForSigning(
  catalog: Pick<ChannelUsageReportPayload, 'seller' | 'sellerAgentId' | 'catalogRoot'>,
): string {
  return JSON.stringify({
    type: 'AntseedSellerCatalog',
    version: 1,
    seller: normalizeAddress(catalog.seller),
    sellerAgentId: BigInt(catalog.sellerAgentId).toString(),
    catalogRoot: catalog.catalogRoot.toLowerCase(),
  });
}

export function verifySellerCatalogSignature(
  report: Pick<ChannelUsageReportPayload, 'seller' | 'sellerAgentId' | 'catalogRoot' | 'sellerCatalogSig'>,
): boolean {
  return verifyUtf8(
    normalizeAddress(report.seller),
    encodeSellerCatalogForSigning(report),
    stripHexPrefix(report.sellerCatalogSig),
  );
}

function verifyUsageLeaves(
  report: ChannelUsageReportPayload,
  usageLeaves: ServiceUsageLeaf[],
  catalogLeafHashes: Map<string, ServiceCatalogLeaf>,
  addIssue: (code: string, message: string) => void,
): void {
  for (const leaf of usageLeaves) {
    if (leaf.channelId.toLowerCase() !== report.channelId.toLowerCase()) {
      addIssue('usage-channel-mismatch', 'service usage leaf channelId does not match report channelId');
    }
    const catalogLeaf = catalogLeafHashes.get(leaf.catalogLeafHash.toLowerCase());
    if (!catalogLeaf) {
      addIssue('missing-usage-catalog-leaf', `usage leaf references unknown catalog leaf ${leaf.catalogLeafHash}`);
      continue;
    }
    if (leaf.serviceIdHash.toLowerCase() !== catalogLeaf.serviceIdHash.toLowerCase()) {
      addIssue('usage-service-mismatch', 'usage leaf serviceIdHash does not match referenced catalog leaf');
    }
    if (toBigInt(leaf.serviceMode) !== toBigInt(catalogLeaf.serviceMode)) {
      addIssue('usage-mode-mismatch', 'usage leaf serviceMode does not match referenced catalog leaf');
    }
    if (toBigInt(leaf.serviceMode) === SERVICE_MODE_FREE && toBigInt(leaf.cumulativeAmountPaid) !== 0n) {
      addIssue('free-usage-paid-amount', 'free service usage leaf has nonzero paid amount');
    }
  }
}

function verifyReceipts(
  report: ChannelUsageReportPayload,
  usageLeaves: ServiceUsageLeaf[],
  receiptLeaves: ReceiptLeaf[],
  catalogLeafHashes: Map<string, ServiceCatalogLeaf>,
  addIssue: (code: string, message: string) => void,
): void {
  const receiptTotals = new Map<string, {
    fresh: bigint;
    cached: bigint;
    output: bigint;
    requests: bigint;
    paid: bigint;
  }>();

  for (const leaf of receiptLeaves) {
    if (leaf.channelId.toLowerCase() !== report.channelId.toLowerCase()) {
      addIssue('receipt-channel-mismatch', 'receipt leaf channelId does not match report channelId');
    }
    const catalogLeaf = catalogLeafHashes.get(leaf.catalogLeafHash.toLowerCase());
    if (!catalogLeaf) {
      addIssue('missing-receipt-catalog-leaf', `receipt references unknown catalog leaf ${leaf.catalogLeafHash}`);
      continue;
    }
    if (leaf.serviceIdHash.toLowerCase() !== catalogLeaf.serviceIdHash.toLowerCase()) {
      addIssue('receipt-service-mismatch', 'receipt serviceIdHash does not match referenced catalog leaf');
    }

    const cost = toBigInt(leaf.costUsdc);
    const mode = toBigInt(catalogLeaf.serviceMode);
    if (mode === SERVICE_MODE_FREE && cost !== 0n) {
      addIssue('free-receipt-cost', 'free service receipt has nonzero costUsdc');
    }
    if (mode === SERVICE_MODE_PAID) {
      const expectedCost = computeCostUsdc(
        Number(toBigInt(leaf.freshInputTokens)),
        Number(toBigInt(leaf.outputTokens)),
        {
          inputUsdPerMillion: Number(toBigInt(catalogLeaf.inputUsdPerMillion)),
          outputUsdPerMillion: Number(toBigInt(catalogLeaf.outputUsdPerMillion)),
          cachedInputUsdPerMillion: Number(toBigInt(catalogLeaf.cachedInputUsdPerMillion)),
        },
        Number(toBigInt(leaf.cachedInputTokens)),
      );
      if (cost !== expectedCost) {
        addIssue('paid-receipt-cost-mismatch', `paid receipt cost ${cost} does not match catalog pricing ${expectedCost}`);
      }
    }

    const key = `${leaf.catalogLeafHash.toLowerCase()}:${leaf.serviceIdHash.toLowerCase()}`;
    const current = receiptTotals.get(key) ?? { fresh: 0n, cached: 0n, output: 0n, requests: 0n, paid: 0n };
    current.fresh += toBigInt(leaf.freshInputTokens);
    current.cached += toBigInt(leaf.cachedInputTokens);
    current.output += toBigInt(leaf.outputTokens);
    current.requests += 1n;
    current.paid += cost;
    receiptTotals.set(key, current);
  }

  for (const usageLeaf of usageLeaves) {
    const key = `${usageLeaf.catalogLeafHash.toLowerCase()}:${usageLeaf.serviceIdHash.toLowerCase()}`;
    const totals = receiptTotals.get(key) ?? { fresh: 0n, cached: 0n, output: 0n, requests: 0n, paid: 0n };
    if (
      totals.fresh !== toBigInt(usageLeaf.cumulativeFreshInputTokens)
        || totals.cached !== toBigInt(usageLeaf.cumulativeCachedInputTokens)
        || totals.output !== toBigInt(usageLeaf.cumulativeOutputTokens)
        || totals.requests !== toBigInt(usageLeaf.cumulativeRequestCount)
        || totals.paid !== toBigInt(usageLeaf.cumulativeAmountPaid)
    ) {
      addIssue('receipt-usage-total-mismatch', 'receipt totals do not aggregate to the service usage leaf');
    }
  }
}

function verifyPaidAuthorization(
  report: ChannelUsageReportPayload,
  metadata: SpendingAuthMetadataV2 | null,
  options: UsageReportVerifierOptions,
  addIssue: (code: string, message: string) => void,
): void {
  if (!metadata) return;
  const cumulativeAmount = BigInt(report.cumulativeAmount);
  const amountPaid = metadata.cumulativeAmountPaid;
  if (amountPaid === 0n && cumulativeAmount === 0n) return;

  if (amountPaid !== cumulativeAmount) {
    addIssue('paid-amount-mismatch', 'metadata cumulativeAmountPaid must equal report cumulativeAmount for paid reports');
  }
  if (!report.buyerSpendingAuthSig) {
    addIssue('missing-buyer-spending-auth', 'paid report is missing buyerSpendingAuthSig');
  } else if (!options.spendingAuthDomain) {
    addIssue('missing-spending-auth-domain', 'paid report verification requires an AntseedChannels EIP-712 domain');
  } else {
    try {
      const recovered = verifyTypedData(
        options.spendingAuthDomain,
        SPENDING_AUTH_TYPES,
        {
          channelId: report.channelId,
          cumulativeAmount,
          metadataHash: report.metadataHash,
        },
        report.buyerSpendingAuthSig,
      );
      if (recovered.toLowerCase() !== report.buyer.toLowerCase()) {
        addIssue('buyer-spending-auth-mismatch', 'buyerSpendingAuthSig does not recover the report buyer');
      }
    } catch (err) {
      addIssue('invalid-buyer-spending-auth', err instanceof Error ? err.message : String(err));
    }
  }

  if (options.settledCumulativeAmount !== undefined && BigInt(options.settledCumulativeAmount) < cumulativeAmount) {
    addIssue('onchain-amount-too-low', 'compatible on-chain settlement is below report cumulativeAmount');
  }
}

function fromCatalogPayload(payload: ChannelUsageReportCatalogLeafPayload): ServiceCatalogLeaf {
  return {
    sellerAgentId: payload.sellerAgentId,
    sellerAddress: payload.sellerAddress,
    serviceIdHash: payload.serviceIdHash,
    tokenizerIdHash: payload.tokenizerIdHash,
    inputUsdPerMillion: payload.inputUsdPerMillion,
    cachedInputUsdPerMillion: payload.cachedInputUsdPerMillion,
    outputUsdPerMillion: payload.outputUsdPerMillion,
    serviceMode: payload.serviceMode,
    termsHash: payload.termsHash,
    validFrom: payload.validFrom,
    validUntil: payload.validUntil,
  };
}

function fromServiceUsagePayload(payload: ChannelUsageReportServiceUsageLeafPayload): ServiceUsageLeaf {
  return {
    channelId: payload.channelId,
    serviceIdHash: payload.serviceIdHash,
    catalogLeafHash: payload.catalogLeafHash,
    serviceMode: payload.serviceMode,
    cumulativeFreshInputTokens: payload.cumulativeFreshInputTokens,
    cumulativeCachedInputTokens: payload.cumulativeCachedInputTokens,
    cumulativeOutputTokens: payload.cumulativeOutputTokens,
    cumulativeRequestCount: payload.cumulativeRequestCount,
    cumulativeAmountPaid: payload.cumulativeAmountPaid,
  };
}

function fromReceiptPayload(payload: ChannelUsageReportReceiptLeafPayload): ReceiptLeaf {
  return {
    channelId: payload.channelId,
    requestIndex: payload.requestIndex,
    requestIdHash: payload.requestIdHash,
    requestHash: payload.requestHash,
    responseHash: payload.responseHash,
    serviceIdHash: payload.serviceIdHash,
    catalogLeafHash: payload.catalogLeafHash,
    freshInputTokens: payload.freshInputTokens,
    cachedInputTokens: payload.cachedInputTokens,
    outputTokens: payload.outputTokens,
    costUsdc: payload.costUsdc,
    cumulativeAmountAfterRequest: payload.cumulativeAmountAfterRequest,
  };
}

function validateReportFields(
  report: ChannelUsageReportPayload,
  addIssue: (code: string, message: string) => void,
): void {
  validateBytes32('channelId', report.channelId, addIssue);
  validateAddress('buyer', report.buyer, addIssue);
  validateAddress('seller', report.seller, addIssue);
  validateUintString('sellerAgentId', report.sellerAgentId, addIssue);
  validateUintString('cumulativeAmount', report.cumulativeAmount, addIssue);
  validateHexData('metadata', report.metadata, addIssue);
  validateBytes32('metadataHash', report.metadataHash, addIssue);
  validateBytes32('selectionBeacon', report.selectionBeacon, addIssue);
  validateUintNumber('verifierCount', report.verifierCount, addIssue);
  validateBytes32('catalogRoot', report.catalogRoot, addIssue);
  validateSignature('sellerCatalogSig', report.sellerCatalogSig, addIssue);
  if (report.buyerSpendingAuthSig !== undefined) {
    validateSignature('buyerSpendingAuthSig', report.buyerSpendingAuthSig, addIssue);
  }
  validateUintNumber('reportedAt', report.reportedAt, addIssue);

  report.serviceCatalogLeaves.forEach((leaf, index) => {
    const prefix = `serviceCatalogLeaves[${index}]`;
    validateUintString(`${prefix}.sellerAgentId`, leaf.sellerAgentId, addIssue);
    validateAddress(`${prefix}.sellerAddress`, leaf.sellerAddress, addIssue);
    validateBytes32(`${prefix}.serviceIdHash`, leaf.serviceIdHash, addIssue);
    validateBytes32(`${prefix}.tokenizerIdHash`, leaf.tokenizerIdHash, addIssue);
    validateUintString(`${prefix}.inputUsdPerMillion`, leaf.inputUsdPerMillion, addIssue);
    validateUintString(`${prefix}.cachedInputUsdPerMillion`, leaf.cachedInputUsdPerMillion, addIssue);
    validateUintString(`${prefix}.outputUsdPerMillion`, leaf.outputUsdPerMillion, addIssue);
    validateUintString(`${prefix}.serviceMode`, leaf.serviceMode, addIssue);
    validateBytes32(`${prefix}.termsHash`, leaf.termsHash, addIssue);
    validateUintString(`${prefix}.validFrom`, leaf.validFrom, addIssue);
    validateUintString(`${prefix}.validUntil`, leaf.validUntil, addIssue);
  });

  report.serviceUsageLeaves.forEach((leaf, index) => {
    const prefix = `serviceUsageLeaves[${index}]`;
    validateBytes32(`${prefix}.channelId`, leaf.channelId, addIssue);
    validateBytes32(`${prefix}.serviceIdHash`, leaf.serviceIdHash, addIssue);
    validateBytes32(`${prefix}.catalogLeafHash`, leaf.catalogLeafHash, addIssue);
    validateUintString(`${prefix}.serviceMode`, leaf.serviceMode, addIssue);
    validateUintString(`${prefix}.cumulativeFreshInputTokens`, leaf.cumulativeFreshInputTokens, addIssue);
    validateUintString(`${prefix}.cumulativeCachedInputTokens`, leaf.cumulativeCachedInputTokens, addIssue);
    validateUintString(`${prefix}.cumulativeOutputTokens`, leaf.cumulativeOutputTokens, addIssue);
    validateUintString(`${prefix}.cumulativeRequestCount`, leaf.cumulativeRequestCount, addIssue);
    validateUintString(`${prefix}.cumulativeAmountPaid`, leaf.cumulativeAmountPaid, addIssue);
  });

  report.receiptLeavesOrProofs.forEach((leaf, index) => {
    const prefix = `receiptLeavesOrProofs[${index}]`;
    validateBytes32(`${prefix}.channelId`, leaf.channelId, addIssue);
    validateUintString(`${prefix}.requestIndex`, leaf.requestIndex, addIssue);
    validateBytes32(`${prefix}.requestIdHash`, leaf.requestIdHash, addIssue);
    validateBytes32(`${prefix}.requestHash`, leaf.requestHash, addIssue);
    validateBytes32(`${prefix}.responseHash`, leaf.responseHash, addIssue);
    validateBytes32(`${prefix}.serviceIdHash`, leaf.serviceIdHash, addIssue);
    validateBytes32(`${prefix}.catalogLeafHash`, leaf.catalogLeafHash, addIssue);
    validateUintString(`${prefix}.freshInputTokens`, leaf.freshInputTokens, addIssue);
    validateUintString(`${prefix}.cachedInputTokens`, leaf.cachedInputTokens, addIssue);
    validateUintString(`${prefix}.outputTokens`, leaf.outputTokens, addIssue);
    validateUintString(`${prefix}.costUsdc`, leaf.costUsdc, addIssue);
    validateUintString(`${prefix}.cumulativeAmountAfterRequest`, leaf.cumulativeAmountAfterRequest, addIssue);
  });

  for (const [leafHash, proof] of Object.entries(report.catalogMerkleProofs)) {
    validateBytes32(`catalogMerkleProofs key ${leafHash}`, leafHash, addIssue);
    proof.forEach((entry, index) => validateBytes32(`catalogMerkleProofs[${leafHash}][${index}]`, entry, addIssue));
  }
}

function validateAddress(field: string, value: string, addIssue: (code: string, message: string) => void): void {
  if (!isAddress(value)) {
    addIssue('invalid-report-field', `${field} must be an EVM address`);
  }
}

function validateBytes32(field: string, value: string, addIssue: (code: string, message: string) => void): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    addIssue('invalid-report-field', `${field} must be a bytes32 hex string`);
  }
}

function validateHexData(field: string, value: string, addIssue: (code: string, message: string) => void): void {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    addIssue('invalid-report-field', `${field} must be even-length hex data`);
  }
}

function validateUintString(field: string, value: string, addIssue: (code: string, message: string) => void): void {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    addIssue('invalid-report-field', `${field} must be a base-10 uint string`);
  }
}

function validateUintNumber(field: string, value: number, addIssue: (code: string, message: string) => void): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    addIssue('invalid-report-field', `${field} must be a non-negative safe integer`);
  }
}

function validateSignature(field: string, value: string, addIssue: (code: string, message: string) => void): void {
  if (!/^(0x)?[0-9a-fA-F]{130}$/.test(value)) {
    addIssue('invalid-report-field', `${field} must be a 65-byte hex signature`);
  }
}

function toBigInt(value: bigint | number | string): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}

function isEligibleVerifierCandidate(
  report: Pick<ChannelUsageReportPayload, 'buyer' | 'seller' | 'sellerAgentId'>,
  candidate: UsageReportVerifierCandidate,
  options: {
    minStakeWeight: bigint;
    minAgeSeconds?: number;
    now: number;
    maxVerificationsForSeller?: number;
  },
): boolean {
  const candidatePeer = normalizeAddress(candidate.peerId);
  if (candidatePeer.length !== 40) return false;
  if (candidate.staked === false) return false;
  if (candidatePeer === normalizeAddress(report.buyer)) return false;
  if (candidatePeer === normalizeAddress(report.seller)) return false;
  if (BigInt(candidate.agentId) === BigInt(report.sellerAgentId)) return false;
  if (toBigInt(candidate.stakeWeight ?? 1n) < options.minStakeWeight) return false;
  if (options.minAgeSeconds !== undefined) {
    if (candidate.firstSeenAt === undefined) return false;
    if (options.now - candidate.firstSeenAt < options.minAgeSeconds) return false;
  }
  if (
    options.maxVerificationsForSeller !== undefined
      && (candidate.verificationCountForSeller ?? 0) >= options.maxVerificationsForSeller
  ) {
    return false;
  }
  return true;
}

function computeVerifierCandidateScore(seed: string, candidate: UsageReportVerifierCandidate): bigint {
  const coder = AbiCoder.defaultAbiCoder();
  const digest = keccak256(coder.encode(
    ['bytes32', 'uint256', 'address'],
    [seed, BigInt(candidate.agentId), ensureAddress(candidate.peerId)],
  ));
  return BigInt(digest);
}

function normalizeAddress(value: string): string {
  return stripHexPrefix(value).toLowerCase();
}

function stripHexPrefix(value: string): string {
  return value.startsWith('0x') ? value.slice(2) : value;
}

function ensureAddress(value: string): string {
  const normalized = normalizeAddress(value);
  if (normalized.length !== 40) {
    throw new Error(`Invalid verifier candidate peerId: ${value}`);
  }
  return `0x${normalized}`;
}
