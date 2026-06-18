import type { AttestationQuote } from "../attestation/types.js";

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
 * rejects mock outside dev). For `tdx`, this is the DCAP integration point:
 * parse the quote, verify the vendor signature chain against Intel PCS
 * collateral, assert debug-disabled and TCB-up-to-date. The interface is
 * implemented; the cryptographic DCAP verification is a clearly-marked TODO.
 */
export interface QuoteValidity {
  genuine: boolean;
  debugDisabled: boolean;
  tcbCurrent: boolean;
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
 * TDX quote validation. INTERFACE IMPLEMENTED; DCAP crypto is a TODO.
 *
 * A complete implementation must:
 *   - Parse the TDX quote header + TD report body.
 *   - Extract MRTD + RTMR0..RTMR3 and fold them into the canonical measurement.
 *   - Extract report_data from td_report[520:584].
 *   - Verify the quote signature chain (PCK -> Intel PCS) using DCAP collateral.
 *   - Assert TD attributes: debug bit OFF; TCB status up-to-date.
 */
function validateTdxQuote(quote: AttestationQuote): QuoteValidity {
  // TODO(tee): integrate Intel DCAP quote verification (e.g. via the QVL or a
  // pure-TS parser + Intel PCS collateral). Until then we extract what we can
  // structurally and report genuine=false so TDX never spuriously passes.
  const reportData = quote.reportData ?? new Uint8Array(0);
  const measurement = quote.measurements.mrtd ?? "";
  return {
    genuine: false, // DCAP verification not yet wired
    debugDisabled: false,
    tcbCurrent: false,
    measurement,
    reportData,
    detail:
      "TDX DCAP verification not yet implemented (integration point) — " +
      "quote treated as unverified",
  };
}
