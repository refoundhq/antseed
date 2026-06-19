import type { AttestationQuote } from "../attestation/types.js";
import { recomputeReportData, reportDataEquals } from "../report-data.js";
import type { RegistryClient } from "../registry/client.js";
import { verifyQuoteGenuineness } from "./quote-verifiers.js";
import type { CheckResult } from "./checks.js";
import { defaultProductionPolicy } from "./policy.js";
import type { VerificationPolicy } from "./policy.js";

export type { CheckResult, CheckStatus, QuoteValidity } from "./checks.js";
export type {
  VerificationPolicy,
  RegistryPolicy,
  TcbPolicy,
} from "./policy.js";
export { defaultProductionPolicy } from "./policy.js";

export interface VerifySellerInput {
  /** The attestation quote returned by the seller for our nonce. */
  quote: AttestationQuote;
  /**
   * Hex secp256k1 pubkey of the peer we actually connected to (P2P channel
   * identity). Must be the cryptographically-authenticated key — derived from
   * the connected peer's authenticated peerId, NOT a value the seller can lie
   * about. Bound into report_data check #3.
   */
  connectedPeerPubkey: string;
  /**
   * Hex ed25519 enclave evidence-signing pubkey served at /pubkey. Trusted only
   * because it is bound into report_data here: a substituted key fails check #3.
   */
  enclavePubkey: string;
  /** Hex nonce we supplied in the /evidence request (replay defense). */
  nonce: string;
  /** Loaded, signature-verified approved-set registry. */
  registry: RegistryClient;
  /**
   * Optional bundle digest from the evidence bundle, for the two-tier check.
   * When the policy supplies `bundleDigestSet` this MUST be present + allowed.
   */
  bundleDigest?: string;
  /**
   * Optional effective-config hash from the evidence bundle. When the policy
   * supplies `configHashSet` this MUST be present + allowed.
   */
  configHash?: string;
  /**
   * The buyer's verification policy. The verifier checks evidence against THIS
   * policy — never a hardcoded measurement or platform. Defaults to
   * {@link defaultProductionPolicy} (TDX, debug-off, TCB-uptodate-or-warn, all
   * bindings required, mock rejected). The registry's approved measurements are
   * always consulted; `policy.measurementSet` can narrow them further.
   */
  policy?: VerificationPolicy;
  /**
   * Allow the `mock` platform to reach a `verified` verdict (dev/test only).
   * Convenience alias for `policy.allowMock`; when set, overrides the policy.
   */
  allowMock?: boolean;
  /**
   * Verification time (unix seconds) for DCAP cert/TCB validity bounds. Defaults
   * to the wall clock; pinned in tests against a fixed-validity fixture.
   */
  nowSecs?: number;
}

export interface VerifySellerResult {
  /** Numbered tri-state checklist. */
  checks: CheckResult[];
  verdict: "verified" | "failed";
  /** Honest list of properties this MVP does NOT prove. */
  notProven: string[];
}

/**
 * The honesty block: properties this MVP (requirement #1 only) does NOT prove.
 * Surfaced verbatim — never hidden.
 */
export const NOT_PROVEN: string[] = [
  // #2 operator-blind
  "Operator-blind (#2): not proven in MVP — the verifier confirms an approved measurement is running, but does not itself prove seller admins cannot read buyer data; that property comes from the audited image.",
  // #3 no-other-processes
  "No-other-processes (#3): not proven in MVP — v1 does not cryptographically prove no side process co-resides with the broker (v2: dm-verity + measured no-other-processes).",
  // #4 model
  "Advertised model == called model (#4): not proven in MVP — there is no model-call transcript binding the served model/effort to the enclave key.",
  // v1 reproducibility
  "v1 is not reproducible: the approved measurement is trusted via the registry's audit; a buyer cannot yet independently re-derive the measurement from source.",
  // provider plaintext
  "Upstream provider sees plaintext: external inference means OpenAI/Anthropic receive the buyer's prompt in the clear. The TEE protects against the seller's admins, not the model provider.",
];

const CHECK1_TITLE =
  "CPU TEE quote genuine (vendor-signed, debug-off, TCB per policy, nonce-fresh)";

/**
 * Verify a TEE seller against a buyer's {@link VerificationPolicy}.
 *
 * The flow is platform-AGNOSTIC — only the quote-genuineness step dispatches per
 * platform (TDX = real DCAP, others = fail-closed). Evidence is consumed
 * agnostically: any seller image on any policy-allowed platform whose
 * measurement is governed-approved (image freedom) and whose evidence satisfies
 * the policy verifies with the same guarantee semantics.
 *
 * Load-bearing checks (all expressed through the policy):
 *   1. Quote genuine on a policy-allowed platform — vendor-signed, debug-off (if
 *      required), TCB per `tcbPolicy`, nonce-fresh.
 *   2. quote.measurement ∈ approved set (registry active set ∩ policy
 *      measurementSet), plus optional bundleDigest / configHash policy.
 *   3. quote.reportData binds {connected peer, enclave key, nonce} per the
 *      policy's binding requirements.
 */
export function verifySeller(input: VerifySellerInput): VerifySellerResult {
  const { quote, connectedPeerPubkey, enclavePubkey, nonce, registry } = input;
  const basePolicy = input.policy ?? defaultProductionPolicy();
  // `allowMock` convenience alias overrides the policy field when supplied.
  const policy: VerificationPolicy =
    input.allowMock === undefined
      ? basePolicy
      : { ...basePolicy, allowMock: input.allowMock };

  const checks: CheckResult[] = [];

  // --- CHECK 1: quote genuine on a policy-allowed platform ---
  const platformAllowed = policy.platforms.includes(quote.platform);
  const g = verifyQuoteGenuineness(quote, input.nowSecs);
  const isMock = quote.platform === "mock";

  if (!platformAllowed) {
    checks.push({
      id: 1,
      title: CHECK1_TITLE,
      status: "fail",
      detail: `platform '${quote.platform}' is not in the policy's allowed platforms [${policy.platforms.join(", ")}]`,
    });
  } else if (isMock && !policy.allowMock) {
    checks.push({
      id: 1,
      title: CHECK1_TITLE,
      status: "fail",
      detail:
        "platform 'mock' is not genuine and allowMock is false — rejected for production",
    });
  } else if (isMock && policy.allowMock && g.genuine) {
    checks.push({
      id: 1,
      title: CHECK1_TITLE,
      status: "warn",
      detail:
        "mock platform accepted under allowMock (dev/test only — NOT a genuine TEE)",
    });
  } else if (!g.genuine) {
    checks.push({ id: 1, title: CHECK1_TITLE, status: "fail", detail: g.detail });
  } else if (policy.requireDebugOff && !g.debugDisabled) {
    checks.push({
      id: 1,
      title: CHECK1_TITLE,
      status: "fail",
      detail: `${g.detail}; debug bit is ON but policy requires debug-off`,
    });
  } else {
    // Genuine + debug acceptable. Apply the TCB policy.
    const tcbResult = evaluateTcb(policy, g.tcbCurrent, g.tcbWarn);
    checks.push({
      id: 1,
      title: CHECK1_TITLE,
      status: tcbResult.status,
      detail: tcbResult.status === "fail" ? `${g.detail}; ${tcbResult.detail}` : g.detail,
    });
  }

  // --- CHECK 2: measurement ∈ approved set (+ optional bundleDigest/configHash) ---
  checks.push(
    measurementCheck(policy, registry, quote.platform, g.measurement, input),
  );

  // --- CHECK 3: report_data binds {peer, enclave, nonce} per policy ---
  checks.push(
    bindingCheck(policy, g.reportData, connectedPeerPubkey, enclavePubkey, nonce, input),
  );

  const allPass = checks.every((c) => c.status === "pass" || c.status === "warn");
  const verdict: VerifySellerResult["verdict"] = allPass ? "verified" : "failed";

  return { checks, verdict, notProven: [...NOT_PROVEN] };
}

/** Map the genuine quote's TCB state onto a tri-state per the buyer's tcbPolicy. */
function evaluateTcb(
  policy: VerificationPolicy,
  tcbCurrent: boolean,
  tcbWarn: boolean | undefined,
): { status: "pass" | "warn" | "fail"; detail: string } {
  if (tcbCurrent) return { status: "pass", detail: "TCB up to date" };
  if (tcbWarn) {
    if (policy.tcbPolicy === "allow-swhardening") {
      return { status: "warn", detail: "TCB needs SW-hardening/configuration (allowed by policy)" };
    }
    return {
      status: "fail",
      detail: "TCB needs SW-hardening/configuration but policy is 'uptodate-only'",
    };
  }
  return { status: "fail", detail: "TCB is out of date / revoked" };
}

/**
 * CHECK 2: the quote's measurement must be governed-approved (in the registry's
 * active set, intersected with the policy's measurementSet when supplied), and
 * any bundleDigest/configHash policy must be satisfied. IMAGE FREEDOM: many
 * measurements may be approved; ANY of them passes.
 */
function measurementCheck(
  policy: VerificationPolicy,
  registry: RegistryClient,
  platform: AttestationQuote["platform"],
  measurement: string,
  input: VerifySellerInput,
): CheckResult {
  const m = measurement.toLowerCase();
  if (measurement.length === 0) {
    return {
      id: 2,
      title: "Measurement ∈ approved set (status=active) + bundle/config policy",
      status: "fail",
      detail: "no measurement could be extracted from the quote",
    };
  }

  const registryApproved = registry.isApproved(platform, measurement);
  const policySetOk = policy.measurementSet ? policy.measurementSet.has(m) : true;
  const measurementApproved = registryApproved && policySetOk;

  // Additional, optional policy inputs: bundleDigest / configHash.
  const extras: string[] = [];
  let extrasFail = false;

  if (policy.bundleDigestSet) {
    const bd = input.bundleDigest?.toLowerCase();
    if (!bd || !policy.bundleDigestSet.has(bd)) {
      extrasFail = true;
      extras.push(
        bd
          ? `bundleDigest ${shorten(bd)} not in the policy's allowed set`
          : "policy requires a bundleDigest but the evidence carries none",
      );
    } else {
      extras.push(`bundleDigest ${shorten(bd)} allowed`);
    }
  } else {
    extras.push("bundleDigest not enforced");
  }

  if (policy.configHashSet) {
    const ch = input.configHash?.toLowerCase();
    if (!ch || !policy.configHashSet.has(ch)) {
      extrasFail = true;
      extras.push(
        ch
          ? `configHash ${shorten(ch)} not in the policy's allowed set`
          : "policy requires a configHash but the evidence carries none",
      );
    } else {
      extras.push(`configHash ${shorten(ch)} allowed`);
    }
  } else {
    extras.push("configHash not enforced");
  }

  const ok = measurementApproved && !extrasFail;
  let detail: string;
  if (!registryApproved) {
    detail = `measurement ${shorten(m)} is not in the registry's approved set (or deprecated/revoked)`;
  } else if (!policySetOk) {
    detail = `measurement ${shorten(m)} is approved by the registry but excluded by the buyer's measurementSet`;
  } else if (extrasFail) {
    detail = `measurement ${shorten(m)} approved, but: ${extras.filter((e) => !e.endsWith("allowed") && !e.endsWith("not enforced")).join("; ")}`;
  } else {
    detail = `measurement ${shorten(m)} is approved for platform ${platform} (${extras.join(", ")})`;
  }

  return {
    id: 2,
    title: "Measurement ∈ approved set (status=active) + bundle/config policy",
    status: ok ? "pass" : "fail",
    detail,
  };
}

/**
 * CHECK 3: report_data must bind the connected peer key + enclave key + nonce
 * per the policy. The recompute always uses all three (the canonical encoder is
 * fixed); the policy flags govern whether a binding is REQUIRED — a policy that
 * does not require all three still recomputes over the supplied values, so this
 * check effectively always enforces the full binding when all three are present.
 */
function bindingCheck(
  policy: VerificationPolicy,
  reportData: Uint8Array,
  connectedPeerPubkey: string,
  enclavePubkey: string,
  nonce: string,
  input: VerifySellerInput,
): CheckResult {
  const required =
    policy.requirePeerBinding ||
    policy.requireEnclaveKeyBinding ||
    policy.requireNonceFreshness;

  const expected = recomputeReportData({
    peerPubkey: connectedPeerPubkey,
    enclavePubkey,
    nonce,
    bundleDigest: input.bundleDigest,
    configHash: input.configHash,
  });
  const boundOk =
    reportData.length === 64 && reportDataEquals(reportData, expected);

  if (!required) {
    // No binding required by policy — report as a non-enforced pass-through.
    return {
      id: 3,
      title: "report_data binds connected peer pubkey + enclave pubkey + buyer nonce",
      status: "warn",
      detail: "report_data binding not required by policy (not enforced)",
    };
  }

  return {
    id: 3,
    title: "report_data binds connected peer pubkey + enclave pubkey + buyer nonce",
    status: boundOk ? "pass" : "fail",
    detail: boundOk
      ? "report_data == packReportData({ connected peer pubkey, enclave pubkey, our nonce })"
      : "report_data does not match the recompute over the connected peer key + " +
        "enclave key + nonce (channel-bind / enclave-key / nonce-freshness failure)",
  };
}

function shorten(hex: string): string {
  return hex.length > 16 ? `${hex.slice(0, 8)}…${hex.slice(-8)}` : hex;
}
