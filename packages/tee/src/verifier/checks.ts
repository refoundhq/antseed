import type { AttestationQuote } from "../attestation/types.js";
import { verifyTdxQuote } from "./dcap.js";

export type CheckStatus = "pass" | "fail" | "warn";

export interface CheckResult {
  /** Stable numeric id of the check in the checklist. */
  id: number;
  /** Human-readable title. */
  title: string;
  status: CheckStatus;
  /** One-line explanation of the outcome. */
  detail: string;
}

/**
 * Result of CHECK 1: is the quote a genuine, debug-off, TCB-current TEE quote
 * with a fresh nonce?
 *
 * For `mock`, validation is purely structural (and never genuine — the verifier
 * rejects mock outside dev). For `tdx`, this runs REAL DCAP verification: parse
 * the quote, verify the ECDSA attestation-key signature + PCK chain to the Intel
 * SGX Root CA against Intel PCS collateral, assert debug-disabled, and evaluate
 * TCB status (see {@link ./dcap.ts}).
 */
export interface QuoteValidity {
  genuine: boolean;
  debugDisabled: boolean;
  tcbCurrent: boolean;
  /**
   * True when the quote is genuine + debug-off but the TCB status is an
   * acceptable-with-warning state (SWHardeningNeeded / ConfigurationNeeded /
   * ConfigurationAndSWHardeningNeeded). CHECK 1 surfaces these as `warn`.
   */
  tcbWarn?: boolean;
  /** Hex measurement extracted from the quote's measurement registers. */
  measurement: string;
  /** The report_data bytes extracted from the parsed quote. */
  reportData: Uint8Array;
  detail: string;
}

const MOCK_BANNER = "ANTSEED-MOCK-QUOTE\0";

/**
 * CHECK 1 backend — validate the quote per-platform and extract the fields the
 * other checks rely on (measurement + report_data).
 */
export function validateQuote(quote: AttestationQuote): QuoteValidity {
  switch (quote.platform) {
    case "mock":
      return validateMockQuote(quote);
    case "tdx":
      return validateTdxQuote(quote);
    case "sev-snp":
      return {
        genuine: false,
        debugDisabled: false,
        tcbCurrent: false,
        measurement: "",
        reportData: new Uint8Array(0),
        detail: "sev-snp quote verification not yet implemented",
      };
    default: {
      const _exhaustive: never = quote.platform;
      return {
        genuine: false,
        debugDisabled: false,
        tcbCurrent: false,
        measurement: "",
        reportData: new Uint8Array(0),
        detail: `unknown platform ${String(_exhaustive)}`,
      };
    }
  }
}

/**
 * Structural validation for the mock platform. NEVER genuine — a mock quote can
 * never satisfy a production verifier. We still parse it so the end-to-end path
 * (report_data binding, measurement set, channel binding) runs without hardware.
 */
function validateMockQuote(quote: AttestationQuote): QuoteValidity {
  const banner = new TextEncoder().encode(MOCK_BANNER);
  const hasBanner =
    quote.quote.length >= banner.length + 64 &&
    banner.every((b, i) => quote.quote[i] === b);
  const reportData = hasBanner
    ? quote.quote.slice(banner.length, banner.length + 64)
    : new Uint8Array(0);
  const measurement = quote.measurements.mrtd ?? "";
  return {
    // `genuine` reflects structural validity here. The verifier separately
    // treats platform 'mock' as non-production (warn) regardless of this flag.
    genuine: hasBanner,
    debugDisabled: true,
    tcbCurrent: true,
    measurement,
    reportData,
    detail: hasBanner
      ? "mock quote structurally valid (NOT genuine — dev/test only)"
      : "mock quote malformed",
  };
}

/**
 * Real Intel TDX DCAP quote validation. Delegates to {@link verifyTdxQuote}
 * (`@phala/dcap-qvl`), which:
 *   - Parses the TDX quote header + TD report body.
 *   - Verifies the ECDSA-P256 attestation-key signature over header+report and
 *     validates the PCK cert chain to the Intel SGX Root CA, using the DCAP
 *     collateral supplied on `quote.collateral` (Intel PCS/PCCS TCB info + QE id).
 *   - Asserts the TD debug bit (TUD.DEBUG) is OFF.
 *   - Evaluates TCB status.
 * We then fold MRTD + RTMR0..RTMR3 into the canonical measurement and extract
 * the 64-byte report_data. Any non-genuine condition throws inside the library
 * and is reported here as genuine=false.
 */
function validateTdxQuote(quote: AttestationQuote): QuoteValidity {
  try {
    const v = verifyTdxQuote(quote);
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
    // A throw means the quote is not genuine (bad signature / broken chain /
    // debug-on / missing collateral / parse failure). Fail closed.
    return {
      genuine: false,
      debugDisabled: false,
      tcbCurrent: false,
      measurement: "",
      reportData: new Uint8Array(0),
      detail: `TDX DCAP verification failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}
