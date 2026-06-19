import { type KeyObject } from "node:crypto";
import type { AttestationPlatform, AttestationProvider } from "../attestation/types.js";
import {
  signEvidenceDocument,
  hashPolicy,
  EVIDENCE_SCHEMA_LAUNCHER,
  type EvidenceDocument,
  type ClaimId,
  type StoragePolicy,
  type NetworkPolicy,
} from "./document.js";
import type { RtmrEvent, ImaEntry } from "./rtmr.js";

/**
 * The seller-side EvidenceBuilder (ARCHITECTURE.md §3). The launcher assembles the
 * evidence document for the subset of claims it attests, then the in-enclave
 * ed25519 key signs it. Optional fields are emitted ONLY for attested claims, so a
 * seller that attests `['hardware-genuine']` serves a minimal doc, while one that
 * attests the full set serves binary + policy + channel-key fields. The buyer's
 * {@link verifyLauncherEvidence} is the exact mirror — build→verify round-trips.
 */
export interface LauncherEvidenceContext {
  platform: AttestationPlatform;
  /** The platform attestor that binds report_data into a quote. */
  attestation: AttestationProvider;
  /** The claims this launcher attests (drives which optional fields are emitted). */
  claims: ClaimId[];
  /** secp256k1 AntSeed peer identity (channel auth). */
  peerPubkey: string;
  /** In-enclave ed25519 evidence key, SPKI-DER hex (bound in report_data). */
  enclavePubkey: string;
  /** Its private half — never leaves the enclave; signs the document. */
  enclavePrivateKey: KeyObject | string;
  /** In-enclave X25519 channel key fingerprint (claim: channel-key-bound). */
  channelPubkey?: string;
  launcherMeasurement?: string;
  launcherVersion?: string;
  antseedBinary?: { digest: string; version: string; tag: string };
  releaseProvenance?: string;
  storagePolicy?: StoragePolicy;
  networkPolicy?: NetworkPolicy;
  configHash?: string;
  bundleDigest?: string;
  eventLogRef?: string;
  /**
   * Measured runtime-policy event log the launcher extended into the runtime RTMR
   * (read from the launcher / sysfs by the seller; the hardware quote's RTMR already
   * reflects these extends). Drives the egress-allowlisted / no-buyer-data-at-rest claims.
   */
  rtmrLog?: RtmrEvent[];
  /** IMA measurement log read from the system (drives known-binaries-only). */
  imaLog?: ImaEntry[];
  /** Which RTMR the IMA log extends (default 2). */
  imaRtmrIndex?: number;
  /** Timestamp (ms). Tests pin it; production passes Date.now(). */
  timestamp: number;
}

/** Assemble + enclave-sign a launcher evidence document bound to the buyer's nonce. */
export async function buildLauncherEvidence(
  ctx: LauncherEvidenceContext,
  nonce: string,
): Promise<EvidenceDocument> {
  const quote = await ctx.attestation.generateQuote({
    peerPubkey: ctx.peerPubkey,
    enclavePubkey: ctx.enclavePubkey,
    nonce,
    bundleDigest: ctx.bundleDigest,
    configHash: ctx.configHash,
  });

  const unsigned: Omit<EvidenceDocument, "enclaveSignature"> = {
    schema: EVIDENCE_SCHEMA_LAUNCHER,
    claims: [...ctx.claims],
    platform: ctx.platform,
    quote: Buffer.from(quote.quote).toString("base64"),
    measurements: quote.measurements,
    reportDataHex: Buffer.from(quote.reportData).toString("hex"),
    nonce,
    peerPubkey: ctx.peerPubkey,
    enclavePubkey: ctx.enclavePubkey,
    timestamp: ctx.timestamp,
    ...(quote.collateral ? { collateral: quote.collateral } : {}),
    ...(ctx.channelPubkey ? { channelPubkey: ctx.channelPubkey, channelKeyAlg: "x25519" as const } : {}),
    ...(ctx.launcherMeasurement ? { launcherMeasurement: ctx.launcherMeasurement } : {}),
    ...(ctx.launcherVersion ? { launcherVersion: ctx.launcherVersion } : {}),
    ...(ctx.antseedBinary
      ? {
          antseedBinaryDigest: ctx.antseedBinary.digest,
          antseedBinaryVersion: ctx.antseedBinary.version,
          antseedBinaryTag: ctx.antseedBinary.tag,
        }
      : {}),
    ...(ctx.releaseProvenance ? { releaseProvenance: ctx.releaseProvenance } : {}),
    ...(ctx.storagePolicy
      ? { storagePolicy: ctx.storagePolicy, storagePolicyHash: hashPolicy(ctx.storagePolicy) }
      : {}),
    ...(ctx.networkPolicy
      ? { networkPolicy: ctx.networkPolicy, networkPolicyHash: hashPolicy(ctx.networkPolicy) }
      : {}),
    ...(ctx.configHash ? { configHash: ctx.configHash } : {}),
    ...(ctx.bundleDigest ? { bundleDigest: ctx.bundleDigest } : {}),
    ...(ctx.eventLogRef ? { eventLogRef: ctx.eventLogRef } : {}),
    ...(ctx.rtmrLog ? { rtmrLog: ctx.rtmrLog } : {}),
    ...(ctx.imaLog ? { imaLog: ctx.imaLog } : {}),
    ...(ctx.imaRtmrIndex !== undefined ? { imaRtmrIndex: ctx.imaRtmrIndex } : {}),
  };

  return { ...unsigned, enclaveSignature: signEvidenceDocument(unsigned, ctx.enclavePrivateKey) };
}
