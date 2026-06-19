import type { AttestationQuote } from "../attestation/types.js";
import { recomputeReportData, reportDataEquals } from "../report-data.js";
import type { RegistryClient } from "../registry/client.js";
import { validateQuote } from "./checks.js";
import type { CheckResult } from "./checks.js";

export type { CheckResult, CheckStatus, QuoteValidity } from "./checks.js";

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
   * Allow the `mock` platform to reach a `verified` verdict (dev/test only).
   * Defaults to false — production rejects mock.
   */
  allowMock?: boolean;
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

/**
 * Verify a TEE seller against the three load-bearing checks for requirement #1:
 *   1. Quote valid — genuine TEE, debug-off, TCB-current, nonce-fresh.
 *   2. quote.measurement ∈ approvedSet (active).
 *   3. quote.reportData ==
 *        packReportData({ peerPubkey: connectedPeer, enclavePubkey, nonce }).
 */
export function verifySeller(input: VerifySellerInput): VerifySellerResult {
  const { quote, connectedPeerPubkey, enclavePubkey, nonce, registry, allowMock = false } = input;
  const checks: CheckResult[] = [];

  // --- CHECK 1: quote validity (genuine, debug-off, TCB-current, fresh) ---
  const validity = validateQuote(quote);
  const isMock = quote.platform === "mock";
  const mockOk = isMock && allowMock;

  if (isMock && !allowMock) {
    checks.push({
      id: 1,
      title: "CPU TEE quote genuine (vendor-signed, debug-off, TCB-current, nonce-fresh)",
      status: "fail",
      detail:
        "platform 'mock' is not genuine and allowMock is false — rejected for production",
    });
  } else if (mockOk && validity.genuine) {
    checks.push({
      id: 1,
      title: "CPU TEE quote genuine (vendor-signed, debug-off, TCB-current, nonce-fresh)",
      status: "warn",
      detail:
        "mock platform accepted under allowMock (dev/test only — NOT a genuine TEE)",
    });
  } else if (validity.genuine && validity.debugDisabled && validity.tcbCurrent) {
    checks.push({
      id: 1,
      title: "CPU TEE quote genuine (vendor-signed, debug-off, TCB-current, nonce-fresh)",
      status: "pass",
      detail: validity.detail,
    });
  } else if (validity.genuine && validity.debugDisabled && validity.tcbWarn) {
    // Genuine, debug-off, but TCB needs SW-hardening / configuration. Acceptable
    // with a surfaced warning rather than a hard fail.
    checks.push({
      id: 1,
      title: "CPU TEE quote genuine (vendor-signed, debug-off, TCB-current, nonce-fresh)",
      status: "warn",
      detail: validity.detail,
    });
  } else {
    checks.push({
      id: 1,
      title: "CPU TEE quote genuine (vendor-signed, debug-off, TCB-current, nonce-fresh)",
      status: "fail",
      detail: validity.detail,
    });
  }

  // --- CHECK 2: measurement ∈ approved set ---
  const measurement = validity.measurement;
  const measurementApproved =
    measurement.length > 0 && registry.isApproved(quote.platform, measurement);
  checks.push({
    id: 2,
    title: "Measurement ∈ approved set (status=active)",
    status: measurementApproved ? "pass" : "fail",
    detail: measurementApproved
      ? `measurement ${shorten(measurement)} is approved for platform ${quote.platform}`
      : measurement.length === 0
        ? "no measurement could be extracted from the quote"
        : `measurement ${shorten(measurement)} is not in the approved set (or deprecated)`,
  });

  // --- CHECK 3: report_data binds peerPubkey + enclavePubkey + nonce ---
  const expected = recomputeReportData({
    peerPubkey: connectedPeerPubkey,
    enclavePubkey,
    nonce,
  });
  // Bind to the connected channel AND the evidence-signing key via the
  // report_data recompute: a quote whose report_data does not match our
  // connected peer's secp256k1 key + the served ed25519 enclave key + our nonce
  // fails here. This is what makes a substituted enclave key (MITM) or a
  // substituted peer pubkey detectable.
  const boundOk =
    validity.reportData.length === 64 &&
    reportDataEquals(validity.reportData, expected);
  checks.push({
    id: 3,
    title: "report_data binds connected peer pubkey + enclave pubkey + buyer nonce",
    status: boundOk ? "pass" : "fail",
    detail: boundOk
      ? "report_data == packReportData({ connected peer pubkey, enclave pubkey, our nonce })"
      : "report_data does not match the recompute over the connected peer key + " +
        "enclave key + nonce (channel-bind / enclave-key / nonce-freshness failure)",
  });

  const allPass = checks.every((c) => c.status === "pass" || c.status === "warn");
  const verdict: VerifySellerResult["verdict"] = allPass ? "verified" : "failed";

  return { checks, verdict, notProven: [...NOT_PROVEN] };
}

function shorten(hex: string): string {
  return hex.length > 16 ? `${hex.slice(0, 8)}…${hex.slice(-8)}` : hex;
}
