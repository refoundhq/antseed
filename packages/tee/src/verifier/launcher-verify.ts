import type { AttestationQuote } from "../attestation/types.js";
import { recomputeReportData, reportDataEquals } from "../report-data.js";
import type { RegistryClient } from "../registry/client.js";
import { verifyReleaseSignature } from "../registry/binary.js";
import { verifyQuoteGenuineness } from "./quote-verifiers.js";
import { defaultProductionPolicy, type VerificationPolicy } from "./policy.js";
import {
  verifyEvidenceSignature,
  hashPolicy,
  type EvidenceDocument,
  type ClaimId,
  type StoragePolicy,
  type NetworkPolicy,
} from "../evidence/document.js";

/**
 * The BuyerPolicyVerifier for the launcher evidence schema (ARCHITECTURE.md §6).
 *
 * The protocol mandates no fixed attestation set. A seller attests to ANY subset
 * of named claims; this verifier reports, per claim, `{claimed, verdict}` and
 * applies the buyer's OWN `requiredClaims` policy. Soundness comes from the
 * dependency lattice: every runtime claim is `verified` only if the binding
 * substrate holds (quote genuine + report_data binds the served enclave key +
 * nonce + peer + the enclave signature over the document verifies). Otherwise the
 * field is unrooted and the claim is `not-proven`, never silently passed.
 */

export type ClaimVerdict = "verified" | "failed" | "not-proven" | "not-claimed";

export interface ClaimResult {
  claim: ClaimId;
  /** Did the seller attest this claim? */
  claimed: boolean;
  verdict: ClaimVerdict;
  detail: string;
}

export interface LauncherVerifyInput {
  evidence: EvidenceDocument;
  /** secp256k1 pubkey of the peer we actually connected to (authenticated, not seller-asserted). */
  connectedPeerPubkey: string;
  /** Hex nonce the buyer supplied for this round. */
  nonce: string;
  /** Loaded, signature-verified, governance-checked registry. */
  registry: RegistryClient;
  policy?: VerificationPolicy;
  /** Verification time (unix seconds) for DCAP validity. Defaults to wall clock. */
  nowSecs?: number;
}

export interface LauncherVerifyResult {
  schema: string;
  /** Trust substrate: quote genuine + report_data binds + enclave signature valid. */
  substrate: { ok: boolean; detail: string };
  /** Every claim, with claimed + verdict (claims the seller omitted are `not-claimed`). */
  claims: ClaimResult[];
  /** Buyer-required claims that are NOT verified. Empty ⇒ requiredSatisfied. */
  unmetRequired: ClaimId[];
  requiredSatisfied: boolean;
  verdict: "verified" | "failed";
  /** Honest caveats that remain regardless of which claims verified. */
  notProven: string[];
}

const GLOBAL_NOT_PROVEN = [
  "Upstream provider sees plaintext: with external inference the model provider receives the buyer's prompt in the clear. The TEE protects against the seller's operator, not the provider.",
];

export function verifyLauncherEvidence(input: LauncherVerifyInput): LauncherVerifyResult {
  const { evidence: doc, connectedPeerPubkey, nonce, registry } = input;
  const policy = input.policy ?? defaultProductionPolicy();

  const quote: AttestationQuote = {
    platform: doc.platform,
    quote: base64ToBytes(doc.quote),
    reportData: hexToBytes(doc.reportDataHex),
    measurements: doc.measurements,
    ...(doc.collateral ? { collateral: doc.collateral } : {}),
  };
  const g = verifyQuoteGenuineness(quote, input.nowSecs);
  const isMock = doc.platform === "mock";
  const platformAllowed = policy.platforms.includes(doc.platform);

  // --- substrate ---
  const expectedRd = recomputeReportData({
    peerPubkey: connectedPeerPubkey,
    enclavePubkey: doc.enclavePubkey,
    nonce,
  });
  const bindingOk = g.reportData.length === 64 && reportDataEquals(g.reportData, expectedRd);
  const sigOk = verifyEvidenceSignature(doc);
  const hardwareReal = platformAllowed && (g.genuine || (isMock && policy.allowMock));
  const docOk = hardwareReal && bindingOk && sigOk;

  const substrateDetail = !platformAllowed
    ? `platform '${doc.platform}' not in allowed [${policy.platforms.join(", ")}]`
    : !hardwareReal
      ? isMock
        ? "mock platform and allowMock is false"
        : `quote not genuine: ${g.detail}`
      : !bindingOk
        ? "report_data does not bind the connected peer + served enclave key + nonce"
        : !sigOk
          ? "enclave signature over the evidence document is invalid"
          : "quote genuine, report_data binds peer+enclave+nonce, enclave signature valid";

  const set = registry.getValidSet();
  const entry = registry.findApprovedEntry(doc.platform, g.measurement);

  const claims: ClaimResult[] = [
    evalHardwareGenuine(doc, policy, g, isMock, bindingOk, hardwareReal),
    evalChannelKey(doc, docOk),
    evalApprovedLauncher(doc, registry, docOk, g.measurement),
    ...evalBinary(doc, set ? registry : undefined, policy, docOk, set),
    evalStorage(doc, entry, policy, docOk),
    evalNetwork(doc, entry, policy, docOk),
    evalCapability("no-operator-shell", doc, entry, docOk),
    evalMemEncryption(doc, g, isMock, docOk),
  ];

  // requiredCapabilities fold into the report via no-operator-shell + storage/network;
  // here we additionally fail-closed if a required capability isn't attested.
  const required = policy.requiredClaims ?? [];
  const byId = new Map(claims.map((c) => [c.claim, c]));
  const unmetRequired = required.filter((c) => byId.get(c)?.verdict !== "verified");
  const requiredSatisfied = unmetRequired.length === 0;

  const notProven = [
    ...claims
      .filter((c) => c.claimed && c.verdict !== "verified")
      .map((c) => `${c.claim}: ${c.verdict} — ${c.detail}`),
    ...GLOBAL_NOT_PROVEN,
  ];

  return {
    schema: doc.schema,
    substrate: { ok: docOk, detail: substrateDetail },
    claims,
    unmetRequired,
    requiredSatisfied,
    verdict: requiredSatisfied ? "verified" : "failed",
    notProven,
  };
}

// ---- per-claim evaluators ----

function notClaimed(claim: ClaimId): ClaimResult {
  return { claim, claimed: false, verdict: "not-claimed", detail: "not attested by the seller" };
}
function notProven(claim: ClaimId, detail: string): ClaimResult {
  return { claim, claimed: true, verdict: "not-proven", detail };
}
function failed(claim: ClaimId, detail: string): ClaimResult {
  return { claim, claimed: true, verdict: "failed", detail };
}
function verified(claim: ClaimId, detail: string): ClaimResult {
  return { claim, claimed: true, verdict: "verified", detail };
}

function tcbAcceptable(policy: VerificationPolicy, g: ReturnType<typeof verifyQuoteGenuineness>): boolean {
  if (g.tcbCurrent) return true;
  return Boolean(g.tcbWarn) && policy.tcbPolicy === "allow-swhardening";
}

function evalHardwareGenuine(
  doc: EvidenceDocument,
  policy: VerificationPolicy,
  g: ReturnType<typeof verifyQuoteGenuineness>,
  isMock: boolean,
  bindingOk: boolean,
  hardwareReal: boolean,
): ClaimResult {
  const c: ClaimId = "hardware-genuine";
  if (!doc.claims.includes(c)) return notClaimed(c);
  if (!bindingOk) return notProven(c, "report_data does not bind peer+enclave+nonce (cannot confirm freshness)");
  if (isMock) {
    return policy.allowMock
      ? verified(c, "mock platform accepted under allowMock (dev only — NOT a genuine TEE)")
      : failed(c, "mock platform is not genuine and allowMock is false");
  }
  if (!hardwareReal) return failed(c, `quote not genuine: ${g.detail}`);
  if (policy.requireDebugOff && !g.debugDisabled) return failed(c, "debug bit is ON but policy requires debug-off");
  if (!tcbAcceptable(policy, g)) return failed(c, "TCB is not acceptable under the buyer's tcbPolicy");
  return verified(c, `genuine ${doc.platform} quote, debug off, TCB ${g.tcbCurrent ? "current" : "warn (allowed)"}`);
}

function evalChannelKey(doc: EvidenceDocument, docOk: boolean): ClaimResult {
  const c: ClaimId = "channel-key-bound";
  if (!doc.claims.includes(c)) return notClaimed(c);
  if (!docOk) return notProven(c, "trust substrate failed — channel key binding cannot be rooted");
  if (!doc.channelPubkey || doc.channelKeyAlg !== "x25519") {
    return failed(c, "claimed but no enclave-signed x25519 channel key is present in the evidence");
  }
  return verified(c, "enclave-custodied x25519 channel key is bound (buyer↔seller traffic e2ee to an in-TEE key)");
}

function evalApprovedLauncher(
  doc: EvidenceDocument,
  registry: RegistryClient,
  docOk: boolean,
  measurement: string,
): ClaimResult {
  const c: ClaimId = "approved-launcher";
  if (!doc.claims.includes(c)) return notClaimed(c);
  if (!docOk) return notProven(c, "trust substrate failed — launcher measurement cannot be rooted");
  if (!registry.getValidSet()) return notProven(c, "no verified registry loaded (governance unusable)");
  if (
    doc.launcherMeasurement &&
    doc.launcherMeasurement.toLowerCase() !== measurement.toLowerCase()
  ) {
    return failed(c, "evidence launcherMeasurement does not match the hardware-measured value");
  }
  if (!registry.isApproved(doc.platform, measurement)) {
    return failed(c, `launcher measurement ${shorten(measurement)} is not an active approved entry`);
  }
  return verified(c, `launcher measurement ${shorten(measurement)} is an approved AntSeed launcher`);
}

function evalBinary(
  doc: EvidenceDocument,
  registry: RegistryClient | undefined,
  policy: VerificationPolicy,
  docOk: boolean,
  set: ReturnType<RegistryClient["getValidSet"]>,
): [ClaimResult, ClaimResult] {
  const approvedId: ClaimId = "approved-binary";
  const activeId: ClaimId = "binary-active";
  const aClaimed = doc.claims.includes(approvedId);
  const actClaimed = doc.claims.includes(activeId);

  if (!aClaimed && !actClaimed) return [notClaimed(approvedId), notClaimed(activeId)];
  if (!docOk) {
    const np = (id: ClaimId) => notProven(id, "trust substrate failed — bound binary digest cannot be rooted");
    return [aClaimed ? np(approvedId) : notClaimed(approvedId), actClaimed ? np(activeId) : notClaimed(activeId)];
  }
  if (!registry || !set) {
    const np = (id: ClaimId) => notProven(id, "no verified registry loaded (governance unusable)");
    return [aClaimed ? np(approvedId) : notClaimed(approvedId), actClaimed ? np(activeId) : notClaimed(activeId)];
  }
  const digest = (doc.antseedBinaryDigest ?? "").toLowerCase().replace(/^0x/, "");
  if (!digest) {
    const f = (id: ClaimId) => failed(id, "no antseedBinaryDigest present in the evidence");
    return [aClaimed ? f(approvedId) : notClaimed(approvedId), actClaimed ? f(activeId) : notClaimed(activeId)];
  }
  const revoked = (set.revokedBinaries ?? []).some((d) => d.toLowerCase().replace(/^0x/, "") === digest);
  const match = (set.binaries ?? []).find((b) => b.digest.toLowerCase().replace(/^0x/, "") === digest);

  // approved-binary: a recognized official release meeting policy (regardless of active/deprecated).
  let approvedRes: ClaimResult;
  if (revoked) approvedRes = failed(approvedId, `binary digest ${shorten(digest)} is revoked`);
  else if (!match) approvedRes = failed(approvedId, `binary digest ${shorten(digest)} is not a recognized AntSeed release`);
  else if (policy.allowedBinaryTags && !policy.allowedBinaryTags.includes(match.tag))
    approvedRes = failed(approvedId, `binary tag '${match.tag}' not in allowed [${policy.allowedBinaryTags.join(", ")}]`);
  else if (policy.requireBinaryVersion && match.version !== policy.requireBinaryVersion)
    approvedRes = failed(approvedId, `binary version ${match.version} != required ${policy.requireBinaryVersion}`);
  else if (policy.pinnedReleaseSigner && (!match.releaseSignature || !verifyReleaseSignature(digest, match.releaseSignature, policy.pinnedReleaseSigner)))
    approvedRes = failed(approvedId, "release signature missing/invalid under the pinned release key");
  else approvedRes = verified(approvedId, `official AntSeed release ${match.version} (${match.tag})`);
  if (!aClaimed) approvedRes = notClaimed(approvedId);

  // binary-active: approved-binary AND the entry is active (not deprecated).
  let activeRes: ClaimResult;
  if (revoked) activeRes = failed(activeId, `binary digest ${shorten(digest)} is revoked`);
  else if (!match) activeRes = failed(activeId, "bound binary is not a recognized release");
  else if (match.status !== "active") activeRes = failed(activeId, `release ${match.version} is ${match.status}`);
  else activeRes = verified(activeId, `release ${match.version} is current (active)`);
  if (!actClaimed) activeRes = notClaimed(activeId);

  return [approvedRes, activeRes];
}

function satisfies<T extends object>(actual: T | undefined, required: Partial<T> | undefined): string | null {
  if (!required) return null;
  if (!actual) return "no policy present in evidence";
  for (const k of Object.keys(required) as (keyof T)[]) {
    if (required[k] !== undefined && actual[k] !== required[k]) {
      return `field '${String(k)}' = ${JSON.stringify(actual[k])} does not meet required ${JSON.stringify(required[k])}`;
    }
  }
  return null;
}

function evalStorage(
  doc: EvidenceDocument,
  entry: ReturnType<RegistryClient["findApprovedEntry"]>,
  policy: VerificationPolicy,
  docOk: boolean,
): ClaimResult {
  const c: ClaimId = "storage-policy";
  if (!doc.claims.includes(c)) return notClaimed(c);
  if (!docOk) return notProven(c, "trust substrate failed — storage policy cannot be rooted");
  if (!doc.storagePolicy || !doc.storagePolicyHash) return failed(c, "claimed but no storage policy present in evidence");
  if (hashPolicy(doc.storagePolicy) !== doc.storagePolicyHash.toLowerCase()) {
    return failed(c, "storagePolicyHash does not match the decoded storage policy");
  }
  if (!entry) return notProven(c, "no approved launcher entry to vouch for this storage policy");
  if (!entry.storagePolicyHash) {
    return notProven(c, "the approved launcher entry does not pin a storage-policy hash (policy is self-declared, not governance-vouched)");
  }
  if (entry.storagePolicyHash.toLowerCase() !== doc.storagePolicyHash.toLowerCase()) {
    return failed(c, "storage policy is not the one the approved launcher entry vouches for");
  }
  const unmet = satisfies<StoragePolicy>(doc.storagePolicy, policy.requiredStorage);
  if (unmet) return failed(c, `governance-backed, but does not meet buyer requirement: ${unmet}`);
  return verified(c, "storage policy is governance-vouched and meets the buyer requirement");
}

function evalNetwork(
  doc: EvidenceDocument,
  entry: ReturnType<RegistryClient["findApprovedEntry"]>,
  policy: VerificationPolicy,
  docOk: boolean,
): ClaimResult {
  const c: ClaimId = "network-policy";
  if (!doc.claims.includes(c)) return notClaimed(c);
  if (!docOk) return notProven(c, "trust substrate failed — network policy cannot be rooted");
  if (!doc.networkPolicy || !doc.networkPolicyHash) return failed(c, "claimed but no network policy present in evidence");
  if (hashPolicy(doc.networkPolicy) !== doc.networkPolicyHash.toLowerCase()) {
    return failed(c, "networkPolicyHash does not match the decoded network policy");
  }
  if (!entry) return notProven(c, "no approved launcher entry to vouch for this network policy");
  if (!entry.networkPolicyHash) {
    return notProven(c, "the approved launcher entry does not pin a network-policy hash (policy is self-declared, not governance-vouched)");
  }
  if (entry.networkPolicyHash.toLowerCase() !== doc.networkPolicyHash.toLowerCase()) {
    return failed(c, "network policy is not the one the approved launcher entry vouches for");
  }
  const unmet = satisfies<NetworkPolicy>(doc.networkPolicy, policy.requiredNetwork);
  if (unmet) return failed(c, `governance-backed, but does not meet buyer requirement: ${unmet}`);
  return verified(c, "network policy is governance-vouched and meets the buyer requirement");
}

function evalCapability(
  capability: string,
  doc: EvidenceDocument,
  entry: ReturnType<RegistryClient["findApprovedEntry"]>,
  docOk: boolean,
): ClaimResult {
  const c = capability as ClaimId;
  if (!doc.claims.includes(c)) return notClaimed(c);
  if (!docOk) return notProven(c, "trust substrate failed — capability cannot be rooted");
  if (!entry) return notProven(c, "no approved launcher entry attests this capability");
  if (!entry.capabilities?.includes(capability)) {
    return failed(c, `the approved launcher measurement does not attest the '${capability}' capability`);
  }
  return verified(c, `approved launcher attests '${capability}'`);
}

function evalMemEncryption(
  doc: EvidenceDocument,
  g: ReturnType<typeof verifyQuoteGenuineness>,
  isMock: boolean,
  docOk: boolean,
): ClaimResult {
  const c: ClaimId = "mem-encryption";
  if (!doc.claims.includes(c)) return notClaimed(c);
  if (isMock) return notProven(c, "mock platform does not encrypt memory");
  if (!docOk || !g.genuine) return notProven(c, "trust substrate failed — memory-encryption cannot be confirmed");
  if (doc.platform === "tdx" || doc.platform === "sev-snp") {
    return verified(c, `${doc.platform} encrypts guest memory by construction`);
  }
  return notProven(c, `memory encryption not established for platform '${doc.platform}'`);
}

function shorten(hex: string): string {
  return hex.length > 16 ? `${hex.slice(0, 8)}…${hex.slice(-8)}` : hex;
}

function hexToBytes(hex: string): Uint8Array {
  const n = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (n.length % 2 !== 0) return new Uint8Array(0);
  const out = new Uint8Array(n.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(n.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function base64ToBytes(b64: string): Uint8Array {
  const buf = Buffer.from(b64, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
