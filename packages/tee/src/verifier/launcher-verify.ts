import type { AttestationQuote } from "../attestation/types.js";
import { recomputeReportData, reportDataEquals } from "../report-data.js";
import type { RegistryClient } from "../registry/client.js";
import { verifyReleaseSignature } from "../registry/binary.js";
import { verifyQuoteGenuineness } from "./quote-verifiers.js";
import { defaultProductionPolicy, type VerificationPolicy } from "./policy.js";
import {
  verifyEvidenceSignature,
  hashPolicy,
  stableStringify,
  type EvidenceDocument,
  type ClaimId,
  type StoragePolicy,
  type NetworkPolicy,
} from "../evidence/document.js";
import {
  rtmrLogAnchored,
  measureDigest,
  findEvent,
  imaLogToEvents,
  RTMR_EVENT,
} from "../evidence/rtmr.js";
import {
  registerClaimEvaluator,
  sealClaimRegistry,
  claimEvaluators,
  type ClaimResult,
  type ClaimContext,
} from "./claims.js";

// ClaimResult / ClaimVerdict / ClaimContext live in ./claims.ts; re-exported here.
// `registerClaimEvaluator` is intentionally NOT re-exported: the protocol claim set
// is SEALED at load, so claims can only be added via an attested @antseed/tee upgrade
// (a new release), never runtime injection or override.
export type { ClaimResult, ClaimVerdict, ClaimContext, ClaimEvaluator } from "./claims.js";
export { claimEvaluators, claimInfo, CLAIM_INFO, isClaimRegistrySealed } from "./claims.js";
export type { ClaimInfo } from "./claims.js";

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

  // Evaluate every registered claim through the pluggable registry. The report
  // covers all registered claims PLUS anything the seller attested or the buyer
  // required, so an unknown/custom claim surfaces (fail-closed if unverifiable).
  const ctx: ClaimContext = {
    doc,
    policy,
    registry,
    set,
    entry,
    g,
    measurement: g.measurement,
    isMock,
    docOk,
    bindingOk,
    hardwareReal,
  };
  const ids = new Set<string>([
    ...claimEvaluators().keys(),
    ...doc.claims,
    ...(policy.requiredClaims ?? []),
  ]);
  const claims: ClaimResult[] = [...ids].map((id) => {
    const ev = claimEvaluators().get(id);
    if (ev) return ev(ctx);
    return doc.claims.includes(id)
      ? { claim: id, claimed: true, verdict: "not-proven", detail: "no verifier is registered for this claim — cannot evaluate" }
      : { claim: id, claimed: false, verdict: "not-claimed", detail: "not attested by the seller" };
  });

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

// ---- MEASURED specific attestations (RTMR-anchored; Tier A) ----

/**
 * A policy is MEASURED iff (a) the rtmrLog has the typed event whose digest equals
 * SHA-384 of the canonical declared policy, AND (b) the rtmrLog replays to the
 * quote's RTMR3 (hardware anchor). Both must hold — a digest match without an
 * anchor is just a self-report; an anchor without a digest match is a different policy.
 */
function policyMeasured(
  doc: EvidenceDocument,
  policyObj: unknown,
  eventType: string,
): { digestMatches: boolean; anchored: boolean } {
  if (!doc.rtmrLog || doc.rtmrLog.length === 0) return { digestMatches: false, anchored: false };
  const ev = findEvent(doc.rtmrLog, eventType);
  if (!ev) return { digestMatches: false, anchored: false };
  const digestMatches = ev.digest.toLowerCase() === measureDigest(stableStringify(policyObj));
  const rtmr3 = doc.measurements["rtmr3"];
  const anchored = Boolean(rtmr3) && rtmrLogAnchored(doc.rtmrLog, 3, rtmr3!);
  return { digestMatches, anchored };
}

function evalEgressAllowlisted(
  doc: EvidenceDocument,
  registry: RegistryClient,
  policy: VerificationPolicy,
  docOk: boolean,
  measurement: string,
): ClaimResult {
  const c: ClaimId = "egress-allowlisted";
  if (!doc.claims.includes(c)) return notClaimed(c);
  if (!docOk) return notProven(c, "trust substrate failed — measured egress policy cannot be rooted");
  if (!registry.isApproved(doc.platform, measurement)) {
    return notProven(c, "launcher measurement is not approved — cannot trust it applied + capability-locked the egress policy");
  }
  if (!doc.networkPolicy) return failed(c, "claimed but no network policy present in evidence");
  const m = policyMeasured(doc, doc.networkPolicy, RTMR_EVENT.egressPolicy);
  if (!m.digestMatches) return failed(c, "the declared egress policy is not the one measured into the RTMR");
  if (!m.anchored) return failed(c, "the RTMR event log does not replay to the quote's RTMR3 (not hardware-anchored)");
  const unmet = satisfies<NetworkPolicy>(doc.networkPolicy, policy.requiredNetwork ?? { denyArbitraryEgress: true });
  if (unmet) return failed(c, `measured, but does not meet the buyer requirement: ${unmet}`);
  return verified(c, "egress allowlist is MEASURED into the RTMR; the approved launcher enforces default-deny with CAP_NET_ADMIN dropped");
}

function evalNoDataAtRest(
  doc: EvidenceDocument,
  registry: RegistryClient,
  policy: VerificationPolicy,
  docOk: boolean,
  measurement: string,
): ClaimResult {
  const c: ClaimId = "no-buyer-data-at-rest";
  if (!doc.claims.includes(c)) return notClaimed(c);
  if (!docOk) return notProven(c, "trust substrate failed — measured storage policy cannot be rooted");
  if (!registry.isApproved(doc.platform, measurement)) {
    return notProven(c, "launcher measurement is not approved — cannot trust it applied + capability-locked the storage policy");
  }
  if (!doc.storagePolicy) return failed(c, "claimed but no storage policy present in evidence");
  const m = policyMeasured(doc, doc.storagePolicy, RTMR_EVENT.storagePolicy);
  if (!m.digestMatches) return failed(c, "the declared storage policy is not the one measured into the RTMR");
  if (!m.anchored) return failed(c, "the RTMR event log does not replay to the quote's RTMR3 (not hardware-anchored)");
  const need: Partial<StoragePolicy> = policy.requiredStorage ?? {
    noPersistentPlaintext: true,
    ephemeralWritable: true,
  };
  const unmet = satisfies<StoragePolicy>(doc.storagePolicy, need);
  if (unmet) return failed(c, `measured, but does not meet the buyer requirement: ${unmet}`);
  return verified(c, "storage policy is MEASURED into the RTMR; writable state is tmpfs/ephemeral, no persistent plaintext (CAP_SYS_ADMIN dropped)");
}

function evalKnownBinariesOnly(
  doc: EvidenceDocument,
  registry: RegistryClient,
  docOk: boolean,
  measurement: string,
): ClaimResult {
  const c: ClaimId = "known-binaries-only";
  if (!doc.claims.includes(c)) return notClaimed(c);
  if (!docOk) return notProven(c, "trust substrate failed — IMA log cannot be rooted");
  if (!registry.isApproved(doc.platform, measurement)) {
    return notProven(c, "launcher measurement is not approved — cannot trust the IMA configuration");
  }
  if (!doc.imaLog || doc.imaLog.length === 0) return failed(c, "claimed but no IMA measurement log present in evidence");
  const idx = doc.imaRtmrIndex ?? 2;
  const rtmr = doc.measurements["rtmr" + idx];
  if (!rtmr || !rtmrLogAnchored(imaLogToEvents(doc.imaLog, idx), idx, rtmr)) {
    return failed(c, `the IMA log does not replay to the quote's RTMR${idx} (not hardware-anchored)`);
  }
  const approved = registry.approvedImaHashes();
  if (approved.size === 0) return notProven(c, "no approved known-binary allowlist is published in the registry");
  const unknown = doc.imaLog.filter((e) => !approved.has(e.hash.toLowerCase().replace(/^0x/, "")));
  if (unknown.length > 0) {
    return failed(c, `${unknown.length} executed binar${unknown.length === 1 ? "y is" : "ies are"} NOT on the approved allowlist (e.g. ${shorten(unknown[0]!.hash)})`);
  }
  return verified(c, `all ${doc.imaLog.length} measured executables are on the approved allowlist (IMA log hardware-anchored in RTMR${idx})`);
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

// ---- register the built-in claim evaluators (pluggable; see ./claims.ts) ----
// Adapters thread the shared ClaimContext into each evaluator. Registration order is
// the report order. A new AntSeed version (or a third party) adds a claim by calling
// registerClaimEvaluator(...) — no change to verifyLauncherEvidence required.
registerClaimEvaluator("hardware-genuine", (c) =>
  evalHardwareGenuine(c.doc, c.policy, c.g, c.isMock, c.bindingOk, c.hardwareReal),
);
registerClaimEvaluator("channel-key-bound", (c) => evalChannelKey(c.doc, c.docOk));
registerClaimEvaluator("approved-launcher", (c) =>
  evalApprovedLauncher(c.doc, c.registry, c.docOk, c.measurement),
);
registerClaimEvaluator("approved-binary", (c) =>
  evalBinary(c.doc, c.set ? c.registry : undefined, c.policy, c.docOk, c.set)[0],
);
registerClaimEvaluator("binary-active", (c) =>
  evalBinary(c.doc, c.set ? c.registry : undefined, c.policy, c.docOk, c.set)[1],
);
registerClaimEvaluator("storage-policy", (c) => evalStorage(c.doc, c.entry, c.policy, c.docOk));
registerClaimEvaluator("network-policy", (c) => evalNetwork(c.doc, c.entry, c.policy, c.docOk));
registerClaimEvaluator("no-operator-shell", (c) =>
  evalCapability("no-operator-shell", c.doc, c.entry, c.docOk),
);
registerClaimEvaluator("mem-encryption", (c) => evalMemEncryption(c.doc, c.g, c.isMock, c.docOk));
registerClaimEvaluator("egress-allowlisted", (c) =>
  evalEgressAllowlisted(c.doc, c.registry, c.policy, c.docOk, c.measurement),
);
registerClaimEvaluator("no-buyer-data-at-rest", (c) =>
  evalNoDataAtRest(c.doc, c.registry, c.policy, c.docOk, c.measurement),
);
registerClaimEvaluator("known-binaries-only", (c) =>
  evalKnownBinariesOnly(c.doc, c.registry, c.docOk, c.measurement),
);

// Seal the protocol claim set: no runtime additions/overrides past this point. A new
// claim ships in a new (attested) @antseed/tee release — a protocol upgrade.
sealClaimRegistry();
