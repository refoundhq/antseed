import { createHash } from "node:crypto";
import {
  Quote,
  QuoteVerifier,
  type Collateral,
  type TcbStatus,
} from "@phala/dcap-qvl";
import type { AttestationQuote } from "../attestation/types.js";

/**
 * Real Intel TDX DCAP quote verification, backed by the pure-JS
 * `@phala/dcap-qvl` library (a maintained port of Intel's QVL). This module is
 * the single place that touches DCAP internals; the verifier checklist
 * (`checks.ts` / `verify.ts`) consumes only {@link verifyTdxQuote}.
 *
 * `verifyTdxQuote` performs the full DCAP verification — ECDSA-P256 over the
 * quote header+report with the attestation key, PCK cert chain validation to
 * the Intel SGX Root CA, QE identity, and TCB-status evaluation against Intel
 * PCS/PCCS collateral — and asserts debug-mode OFF (the library rejects a
 * TUD.DEBUG-set TD by default). It then extracts MRTD + RTMR0..3 and the 64-byte
 * report_data from the parsed TD report.
 *
 * Collateral is NOT fetched here: it must be supplied on `quote.collateral`.
 * The seller fetches it (Intel PCS, by FMSPC) and embeds it in the evidence
 * bundle (see `attestation/collateral.ts`), so verification stays a pure,
 * synchronous, network-free function — the verifier never makes an implicit
 * outbound call while deciding a verdict.
 */

/** How a TCB status maps onto the verifier's tri-state. */
export type TcbVerdict = "current" | "warn" | "stale";

export interface TdxVerification {
  /** Cryptographically genuine: Intel-signed quote, chain valid to Intel Root CA. */
  genuine: boolean;
  /** TD debug bit (TUD.DEBUG) is OFF. */
  debugDisabled: boolean;
  /** Raw Intel TCB status (e.g. "UpToDate", "SWHardeningNeeded", "OutOfDate"). */
  tcbStatus: TcbStatus;
  /** Verifier tri-state derived from {@link tcbStatus}. */
  tcbVerdict: TcbVerdict;
  /** Canonical measurement = sha256(MRTD || RTMR0 || RTMR1 || RTMR2 || RTMR3), hex. */
  measurement: string;
  /** Individual measurement registers, hex (mrtd, rtmr0..rtmr3). */
  registers: Record<string, string>;
  /** The 64-byte report_data extracted from the TD report. */
  reportData: Uint8Array;
  /** Intel advisory IDs surfaced by the TCB evaluation (may be empty). */
  advisoryIds: string[];
  detail: string;
}

/**
 * Statuses that mean "genuine and acceptable, but surface a warning". A buyer
 * may still proceed; the verdict downgrades to `warn` rather than `fail`.
 */
const WARN_STATUSES: ReadonlySet<TcbStatus> = new Set<TcbStatus>([
  "SWHardeningNeeded",
  "ConfigurationNeeded",
  "ConfigurationAndSWHardeningNeeded",
]);

function tcbVerdictFor(status: TcbStatus): TcbVerdict {
  if (status === "UpToDate") return "current";
  if (WARN_STATUSES.has(status)) return "warn";
  return "stale"; // OutOfDate, OutOfDateConfigurationNeeded, Revoked, Unknown
}

function toHex(u8: Uint8Array): string {
  return Buffer.from(u8).toString("hex");
}

/**
 * Canonical TDX measurement: fold MRTD + RTMR0..RTMR3 into one stable hex value
 * so the approved-set check pins the full TD launch + runtime-extension state,
 * not MRTD alone. Domain-separated by a fixed tag.
 */
export function canonicalTdxMeasurement(registers: {
  mrtd: Uint8Array;
  rtmr0: Uint8Array;
  rtmr1: Uint8Array;
  rtmr2: Uint8Array;
  rtmr3: Uint8Array;
}): string {
  const h = createHash("sha256");
  h.update(Buffer.from("antseed-tee/tdx-measurement/v1\0"));
  h.update(Buffer.from(registers.mrtd));
  h.update(Buffer.from(registers.rtmr0));
  h.update(Buffer.from(registers.rtmr1));
  h.update(Buffer.from(registers.rtmr2));
  h.update(Buffer.from(registers.rtmr3));
  return h.digest("hex");
}

/**
 * Adapt the protocol's `collateral` map (Record<string,string>) into the shape
 * `@phala/dcap-qvl` expects. The library tolerates both JSON-string and
 * byte-array forms for the CRL/signature fields, so passing strings through is
 * sufficient.
 */
function toLibCollateral(c: Record<string, string>): Collateral {
  const required = [
    "pck_crl_issuer_chain",
    "root_ca_crl",
    "pck_crl",
    "tcb_info_issuer_chain",
    "tcb_info",
    "tcb_info_signature",
    "qe_identity_issuer_chain",
    "qe_identity",
    "qe_identity_signature",
  ];
  for (const k of required) {
    if (c[k] === undefined) {
      throw new Error(`TDX collateral missing required field '${k}'`);
    }
  }
  return c as unknown as Collateral;
}

/**
 * Verify a real Intel TDX quote. Throws on any non-genuine condition
 * (bad signature, broken cert chain, debug-on, parse failure). On success
 * returns the extracted measurement state + TCB verdict.
 *
 * @param quote        the attestation quote (raw DCAP bytes in `quote.quote`).
 * @param nowSecs      verification time (unix seconds) — used to bound cert /
 *                     TCB validity. Defaults to now.
 */
export function verifyTdxQuote(
  quote: AttestationQuote,
  nowSecs: number = Math.floor(Date.now() / 1000),
): TdxVerification {
  if (!quote.collateral) {
    throw new Error(
      "TDX verification requires DCAP collateral on quote.collateral " +
        "(fetch from Intel PCS/PCCS) — none supplied",
    );
  }

  const raw = Buffer.from(quote.quote);
  const collateral = toLibCollateral(quote.collateral);

  // Full DCAP verification: ECDSA over header+report with the attestation key,
  // PCK chain to the Intel SGX Root CA, QE identity, and TCB evaluation.
  // allowDebug defaults to false, so a debug-mode TD is rejected here.
  const verifier = QuoteVerifier.newProd();
  const report = verifier.verify(raw, collateral, nowSecs);

  // Parse the quote to extract the TD measurement registers + report_data.
  const parsed = Quote.parse(raw);
  const td10 = parsed.report.asTd10();
  const td15 = parsed.report.asTd15();
  const td = td10 ?? td15?.base ?? null;
  if (!td) {
    throw new Error(
      `quote is not a TDX TD report (report type '${parsed.report.type}')`,
    );
  }

  const registers = {
    mrtd: td.mrTd,
    rtmr0: td.rtMr0,
    rtmr1: td.rtMr1,
    rtmr2: td.rtMr2,
    rtmr3: td.rtMr3,
  };
  const measurement = canonicalTdxMeasurement(registers);

  const status = report.status;
  const tcbVerdict = tcbVerdictFor(status);

  return {
    genuine: true, // verify() did not throw => Intel-signed chain validated
    debugDisabled: true, // verify() rejects TUD.DEBUG-set TDs (allowDebug=false)
    tcbStatus: status,
    tcbVerdict,
    measurement,
    registers: {
      mrtd: toHex(registers.mrtd),
      rtmr0: toHex(registers.rtmr0),
      rtmr1: toHex(registers.rtmr1),
      rtmr2: toHex(registers.rtmr2),
      rtmr3: toHex(registers.rtmr3),
    },
    reportData: Uint8Array.from(td.reportData),
    advisoryIds: report.advisory_ids ?? [],
    detail: `Intel TDX quote verified (TCB ${status})`,
  };
}
