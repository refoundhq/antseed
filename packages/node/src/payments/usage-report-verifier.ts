import { AbiCoder, isAddress, keccak256, type TypedDataDomain, verifyTypedData, type Wallet } from 'ethers';
import type {
  ChannelReportAttestationPayload,
  ChannelUsageReportPayload,
  ChannelUsageReportServiceUsageRowPayload,
  UsageReportAckPayload,
} from '../types/protocol.js';
import type { PeerMetadata, TokenPricingUsdPerMillion } from '../discovery/peer-metadata.js';
import { encodeMetadataForSigning } from '../discovery/metadata-codec.js';
import { computeCostUsdc } from './pricing.js';
import { signUtf8, verifySignature, verifyUtf8 } from '../p2p/identity.js';
import { hexToBytes } from '../utils/hex.js';
import {
  computeEncodedMetadataHash,
  computePricingCatalogRoot,
  computeServiceUsageRoot,
  decodeMetadata,
  hashServicePricing,
  hashUtf8,
  metadataV2MatchesServiceUsage,
  SERVICE_MODE_FREE,
  SERVICE_MODE_PAID,
  SPENDING_AUTH_TYPES,
  ZERO_BYTES32,
  type ServiceUsageRow,
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
  /** Existing signed seller /metadata resolved through DHT/http. Used as pricing source of truth. */
  sellerMetadata?: PeerMetadata | null;
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
      report.pricingCatalogRoot,
      computeServiceUsageRoot(report.serviceUsageRows.map(fromServiceUsageRowPayload)),
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

  const usageRows = report.serviceUsageRows.map(fromServiceUsageRowPayload);

  if (metadata) {
    if (metadata.pricingCatalogRoot.toLowerCase() !== report.pricingCatalogRoot.toLowerCase()) {
      addIssue('pricing-catalog-mismatch', 'report pricingCatalogRoot does not match metadata pricing commitment');
    }
    if (!metadataV2MatchesServiceUsage(metadata, usageRows)) {
      addIssue('service-usage-root-or-total-mismatch', 'serviceUsageRoot or usage totals do not match service usage rows');
    }
    if (metadata.receiptRoot.toLowerCase() !== ZERO_BYTES32) {
      addIssue('unsupported-receipt-root', 'simplified usage reports require zero receiptRoot');
    }
  }

  verifyUsageRows(report, usageRows, addIssue);
  verifyAnnouncedPricing(report, usageRows, options.sellerMetadata ?? null, addIssue);
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
    pricingCatalogRoot: report.pricingCatalogRoot,
    serviceUsageRoot: verification.metadata.serviceUsageRoot,
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
    pricingCatalogRoot: attestation.pricingCatalogRoot,
    serviceUsageRoot: attestation.serviceUsageRoot,
    verifier: normalizeAddress(attestation.verifier),
    verifierAgentId: attestation.verifierAgentId,
    timestamp: attestation.timestamp,
  });
}

function verifyUsageRows(
  report: ChannelUsageReportPayload,
  usageRows: ServiceUsageRow[],
  addIssue: (code: string, message: string) => void,
): void {
  for (const row of usageRows) {
    if (row.channelId.toLowerCase() !== report.channelId.toLowerCase()) {
      addIssue('usage-channel-mismatch', 'service usage row channelId does not match report channelId');
    }
    const expectedServiceIdHash = serviceIdHash(row.provider, row.service);
    if (row.serviceIdHash.toLowerCase() !== expectedServiceIdHash.toLowerCase()) {
      addIssue('usage-service-hash-mismatch', 'service usage row serviceIdHash does not match provider/service');
    }
    const expectedServicePricingHash = hashServicePricing({
      serviceIdHash: row.serviceIdHash,
      inputUsdPerMillion: row.inputUsdPerMillion,
      cachedInputUsdPerMillion: row.cachedInputUsdPerMillion,
      outputUsdPerMillion: row.outputUsdPerMillion,
      serviceMode: row.serviceMode,
    });
    if (row.servicePricingHash.toLowerCase() !== expectedServicePricingHash.toLowerCase()) {
      addIssue('usage-service-pricing-hash-mismatch', 'service usage row servicePricingHash does not match row pricing fields');
    }
    if (toBigInt(row.serviceMode) === SERVICE_MODE_FREE && toBigInt(row.cumulativeAmountPaid) !== 0n) {
      addIssue('free-usage-paid-amount', 'free service usage row has nonzero paid amount');
    }
  }
}

function verifyAnnouncedPricing(
  report: ChannelUsageReportPayload,
  usageRows: ServiceUsageRow[],
  metadata: PeerMetadata | null,
  addIssue: (code: string, message: string) => void,
): void {
  if (!metadata) {
    addIssue('missing-seller-metadata', 'usage report verification requires the seller signed metadata used for pricing');
    return;
  }

  const expectedPricingCatalogRoot = derivePricingCatalogRoot(metadata);
  if (report.pricingCatalogRoot.toLowerCase() !== expectedPricingCatalogRoot.toLowerCase()) {
    addIssue('pricing-catalog-root-mismatch', 'report pricingCatalogRoot does not match seller metadata pricing catalog');
  }

  const metadataSeller = metadata.sellerContract
    ? `0x${metadata.sellerContract}`
    : `0x${metadata.peerId}`;
  if (metadataSeller.toLowerCase() !== report.seller.toLowerCase()) {
    addIssue('seller-metadata-mismatch', 'seller metadata identity does not match report seller');
  }
  if (!verifySellerMetadataSignature(metadata)) {
    addIssue('invalid-seller-metadata-signature', 'seller metadata signature does not recover metadata peerId');
  }

  for (const row of usageRows) {
    const pricing = getAnnouncedServicePricing(metadata, row.provider, row.service);
    if (!pricing) {
      addIssue('missing-announced-service-pricing', `seller metadata does not announce pricing for ${row.provider}:${row.service}`);
      continue;
    }
    const expectedMode = isFreePricing(pricing) ? SERVICE_MODE_FREE : SERVICE_MODE_PAID;
    if (toBigInt(row.serviceMode) !== expectedMode) {
      addIssue('usage-mode-pricing-mismatch', 'service usage mode does not match announced pricing');
    }
    const expectedCachedPrice = pricing.cachedInputUsdPerMillion ?? pricing.inputUsdPerMillion;
    const expectedServicePricingHash = hashServicePricing({
      serviceIdHash: row.serviceIdHash,
      inputUsdPerMillion: pricing.inputUsdPerMillion,
      cachedInputUsdPerMillion: expectedCachedPrice,
      outputUsdPerMillion: pricing.outputUsdPerMillion,
      serviceMode: expectedMode,
    });
    if (row.servicePricingHash.toLowerCase() !== expectedServicePricingHash.toLowerCase()) {
      addIssue('usage-service-pricing-catalog-mismatch', 'service usage row servicePricingHash is not the announced service pricing hash');
    }
    if (
      toBigInt(row.inputUsdPerMillion) !== BigInt(pricing.inputUsdPerMillion)
      || toBigInt(row.cachedInputUsdPerMillion) !== BigInt(expectedCachedPrice)
      || toBigInt(row.outputUsdPerMillion) !== BigInt(pricing.outputUsdPerMillion)
    ) {
      addIssue('usage-pricing-mismatch', 'service usage row pricing does not match announced metadata pricing');
    }
    const expectedCost = computeCostUsdc(
      Number(toBigInt(row.cumulativeFreshInputTokens)),
      Number(toBigInt(row.cumulativeOutputTokens)),
      {
        inputUsdPerMillion: Number(toBigInt(row.inputUsdPerMillion)),
        cachedInputUsdPerMillion: Number(toBigInt(row.cachedInputUsdPerMillion)),
        outputUsdPerMillion: Number(toBigInt(row.outputUsdPerMillion)),
      },
      Number(toBigInt(row.cumulativeCachedInputTokens)),
    );
    if (expectedCost !== toBigInt(row.cumulativeAmountPaid)) {
      addIssue('announced-pricing-cost-mismatch', `service usage paid amount ${row.cumulativeAmountPaid} does not match announced pricing ${expectedCost}`);
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

function fromServiceUsageRowPayload(payload: ChannelUsageReportServiceUsageRowPayload): ServiceUsageRow {
  return {
    channelId: payload.channelId,
    provider: payload.provider,
    service: payload.service,
    serviceIdHash: payload.serviceIdHash,
    servicePricingHash: payload.servicePricingHash,
    inputUsdPerMillion: payload.inputUsdPerMillion,
    cachedInputUsdPerMillion: payload.cachedInputUsdPerMillion,
    outputUsdPerMillion: payload.outputUsdPerMillion,
    serviceMode: payload.serviceMode,
    cumulativeFreshInputTokens: payload.cumulativeFreshInputTokens,
    cumulativeCachedInputTokens: payload.cumulativeCachedInputTokens,
    cumulativeOutputTokens: payload.cumulativeOutputTokens,
    cumulativeRequestCount: payload.cumulativeRequestCount,
    cumulativeAmountPaid: payload.cumulativeAmountPaid,
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
  validateBytes32('pricingCatalogRoot', report.pricingCatalogRoot, addIssue);
  if (report.buyerSpendingAuthSig !== undefined) {
    validateSignature('buyerSpendingAuthSig', report.buyerSpendingAuthSig, addIssue);
  }
  validateUintNumber('reportedAt', report.reportedAt, addIssue);

  report.serviceUsageRows.forEach((row, index) => {
    const prefix = `serviceUsageRows[${index}]`;
    validateBytes32(`${prefix}.channelId`, row.channelId, addIssue);
    validateNonEmptyString(`${prefix}.provider`, row.provider, addIssue);
    validateNonEmptyString(`${prefix}.service`, row.service, addIssue);
    validateBytes32(`${prefix}.serviceIdHash`, row.serviceIdHash, addIssue);
    validateBytes32(`${prefix}.servicePricingHash`, row.servicePricingHash, addIssue);
    validateUintString(`${prefix}.inputUsdPerMillion`, row.inputUsdPerMillion, addIssue);
    validateUintString(`${prefix}.cachedInputUsdPerMillion`, row.cachedInputUsdPerMillion, addIssue);
    validateUintString(`${prefix}.outputUsdPerMillion`, row.outputUsdPerMillion, addIssue);
    validateUintString(`${prefix}.serviceMode`, row.serviceMode, addIssue);
    validateUintString(`${prefix}.cumulativeFreshInputTokens`, row.cumulativeFreshInputTokens, addIssue);
    validateUintString(`${prefix}.cumulativeCachedInputTokens`, row.cumulativeCachedInputTokens, addIssue);
    validateUintString(`${prefix}.cumulativeOutputTokens`, row.cumulativeOutputTokens, addIssue);
    validateUintString(`${prefix}.cumulativeRequestCount`, row.cumulativeRequestCount, addIssue);
    validateUintString(`${prefix}.cumulativeAmountPaid`, row.cumulativeAmountPaid, addIssue);
  });
}

export function serviceIdHash(provider: string, service: string): string {
  return hashUtf8(`${provider.trim().toLowerCase()}:${service.trim()}`);
}

export function derivePricingCatalogRoot(metadata: PeerMetadata): string {
  return computePricingCatalogRoot(metadata.providers.flatMap((provider) =>
    provider.services.map((service) => {
      const pricing = provider.servicePricing?.[service] ?? provider.defaultPricing;
      const cachedInputUsdPerMillion = pricing.cachedInputUsdPerMillion ?? pricing.inputUsdPerMillion;
      return {
        serviceIdHash: serviceIdHash(provider.provider, service),
        inputUsdPerMillion: pricing.inputUsdPerMillion,
        cachedInputUsdPerMillion,
        outputUsdPerMillion: pricing.outputUsdPerMillion,
        serviceMode: isFreePricing(pricing) ? SERVICE_MODE_FREE : SERVICE_MODE_PAID,
      };
    })
  ));
}

function verifySellerMetadataSignature(metadata: PeerMetadata): boolean {
  try {
    return verifySignature(
      metadata.peerId,
      hexToBytes(metadata.signature),
      encodeMetadataForSigning(metadata),
    );
  } catch {
    return false;
  }
}

function getAnnouncedServicePricing(
  metadata: PeerMetadata,
  providerName: string,
  serviceName: string,
): TokenPricingUsdPerMillion | null {
  const provider = metadata.providers.find((entry) => entry.provider === providerName);
  if (!provider || !provider.services.includes(serviceName)) return null;
  return provider.servicePricing?.[serviceName] ?? provider.defaultPricing;
}

function isFreePricing(pricing: TokenPricingUsdPerMillion): boolean {
  const cached = pricing.cachedInputUsdPerMillion ?? pricing.inputUsdPerMillion;
  return pricing.inputUsdPerMillion === 0 && cached === 0 && pricing.outputUsdPerMillion === 0;
}

function validateAddress(field: string, value: string, addIssue: (code: string, message: string) => void): void {
  if (!isAddress(value)) {
    addIssue('invalid-report-field', `${field} must be an EVM address`);
  }
}

function validateNonEmptyString(field: string, value: string, addIssue: (code: string, message: string) => void): void {
  if (typeof value !== 'string' || value.length === 0) {
    addIssue('invalid-report-field', `${field} must be a non-empty string`);
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
