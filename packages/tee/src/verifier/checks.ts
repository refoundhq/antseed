import type { AttestationQuote } from "../attestation/types.js";
import { verifyQuoteGenuineness } from "./quote-verifiers.js";

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
 * Quote genuineness is platform-DISPATCHED (see {@link ./quote-verifiers.ts}):
 * `tdx` runs REAL DCAP verification; `mock` is structural-only (never genuine);
 * every other platform fails closed. This struct is the platform-agnostic shape
 * the policy engine consumes — it never branches on the silicon vendor.
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

/**
 * CHECK 1 backend — validate the quote on its platform and extract the fields
 * the other checks rely on (measurement + report_data). Thin adapter over the
 * platform-dispatched {@link verifyQuoteGenuineness}; kept as a stable export so
 * existing callers/tests continue to work.
 */
export function validateQuote(
  quote: AttestationQuote,
  nowSecs?: number,
): QuoteValidity {
  const g = verifyQuoteGenuineness(quote, nowSecs);
  return {
    genuine: g.genuine,
    debugDisabled: g.debugDisabled,
    tcbCurrent: g.tcbCurrent,
    tcbWarn: g.tcbWarn,
    measurement: g.measurement,
    reportData: g.reportData,
    detail: g.detail,
  };
}
