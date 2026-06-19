import type { AttestationPlatform, AttestationQuote } from "../attestation/types.js";
import { verifyTdxQuote } from "./dcap.js";

/**
 * Platform-dispatched quote genuineness.
 *
 * `verifySeller` is platform-AGNOSTIC: it evaluates a buyer's policy over the
 * evidence and never branches on the silicon vendor itself. The ONLY part that
 * knows about TDX vs SEV-SNP is the per-platform quote verifier selected here.
 * Adding a new platform = registering a real verifier in {@link QUOTE_VERIFIERS};
 * nothing else in the flow changes.
 *
 * Every platform that is not yet really implemented gets a `NotImplemented`
 * verifier that FAILS CLOSED (`genuine: false`) — it never silently passes, so a
 * buyer can never be fooled into trusting an unverified platform.
 */

/** A platform's quote genuineness result, normalized for the policy engine. */
export interface QuoteGenuineness {
  /** Cryptographically genuine: vendor-signed quote, chain valid to vendor root. */
  genuine: boolean;
  /** The TEE debug bit is OFF. */
  debugDisabled: boolean;
  /** TCB is current (e.g. Intel `UpToDate`). */
  tcbCurrent: boolean;
  /**
   * TCB is genuine + acceptable-with-warning (SW-hardening / configuration
   * needed). Mutually exclusive with `tcbCurrent` in practice.
   */
  tcbWarn: boolean;
  /** Canonical hex measurement extracted from the quote's measurement registers. */
  measurement: string;
  /** The report_data bytes extracted from the parsed quote. */
  reportData: Uint8Array;
  /** One-line human-readable explanation of the outcome. */
  detail: string;
}

/** A per-platform quote verifier. Pure + synchronous (collateral travels inline). */
export type QuoteVerifierFn = (
  quote: AttestationQuote,
  nowSecs?: number,
) => QuoteGenuineness;

/** Fail-closed result for a not-yet-implemented platform. */
function notImplemented(platform: string): QuoteGenuineness {
  return {
    genuine: false,
    debugDisabled: false,
    tcbCurrent: false,
    tcbWarn: false,
    measurement: "",
    reportData: new Uint8Array(0),
    detail:
      `quote verification for platform '${platform}' is not implemented — ` +
      `failing closed (this platform is NOT trusted)`,
  };
}

/** Build a NotImplemented verifier bound to a platform name. */
function notImplementedVerifier(platform: string): QuoteVerifierFn {
  return () => notImplemented(platform);
}

/**
 * Real Intel TDX DCAP verifier. Delegates to {@link verifyTdxQuote}
 * (`@phala/dcap-qvl`): ECDSA over header+report, PCK chain to the Intel SGX Root
 * CA, QE identity, TCB evaluation, debug-off assertion. Any non-genuine
 * condition throws inside the library and is reported as `genuine: false`.
 */
const tdxVerifier: QuoteVerifierFn = (quote, nowSecs) => {
  try {
    const v = verifyTdxQuote(quote, nowSecs);
    return {
      genuine: v.genuine,
      debugDisabled: v.debugDisabled,
      tcbCurrent: v.tcbVerdict === "current",
      tcbWarn: v.tcbVerdict === "warn",
      measurement: v.measurement,
      reportData: v.reportData,
      detail:
        v.advisoryIds.length > 0
          ? `${v.detail}; advisories: ${v.advisoryIds.join(", ")}`
          : v.detail,
    };
  } catch (err) {
    return {
      genuine: false,
      debugDisabled: false,
      tcbCurrent: false,
      tcbWarn: false,
      measurement: "",
      reportData: new Uint8Array(0),
      detail: `TDX DCAP verification failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
};

const MOCK_BANNER = "ANTSEED-MOCK-QUOTE\0";

/**
 * Structural-only verifier for the dev/test `mock` platform. NEVER genuine — the
 * policy engine treats `mock` as non-production and only allows it to reach a
 * verdict under an explicit `allowMock`. We still parse it so the end-to-end path
 * (report_data binding, measurement set, channel binding) runs without hardware.
 */
const mockVerifier: QuoteVerifierFn = (quote) => {
  const banner = new TextEncoder().encode(MOCK_BANNER);
  const hasBanner =
    quote.quote.length >= banner.length + 64 &&
    banner.every((b, i) => quote.quote[i] === b);
  const reportData = hasBanner
    ? quote.quote.slice(banner.length, banner.length + 64)
    : new Uint8Array(0);
  const measurement = quote.measurements.mrtd ?? "";
  return {
    genuine: hasBanner,
    debugDisabled: true,
    tcbCurrent: true,
    tcbWarn: false,
    measurement,
    reportData,
    detail: hasBanner
      ? "mock quote structurally valid (NOT genuine — dev/test only)"
      : "mock quote malformed",
  };
};

/**
 * The per-platform quote-verifier registry. `tdx` is the real DCAP path; `mock`
 * is structural (dev/test); every other declared platform fails closed via a
 * clearly-marked NotImplemented verifier.
 */
export const QUOTE_VERIFIERS: Record<AttestationPlatform, QuoteVerifierFn> = {
  tdx: tdxVerifier,
  "sev-snp": notImplementedVerifier("sev-snp"),
  mock: mockVerifier,
};

/**
 * Verify a quote's genuineness on its platform. Unknown platforms fail closed.
 */
export function verifyQuoteGenuineness(
  quote: AttestationQuote,
  nowSecs?: number,
): QuoteGenuineness {
  const verifier = QUOTE_VERIFIERS[quote.platform];
  if (!verifier) return notImplemented(String(quote.platform));
  return verifier(quote, nowSecs);
}

/** True if a real (non-NotImplemented, non-mock) verifier backs this platform. */
export function isPlatformImplemented(platform: AttestationPlatform): boolean {
  return platform === "tdx";
}
