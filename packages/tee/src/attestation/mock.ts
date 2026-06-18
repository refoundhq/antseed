import { packReportData } from "../report-data.js";
import type {
  AttestationProvider,
  AttestationQuote,
  ReportDataBindings,
} from "./types.js";

/**
 * Fixed, clearly-non-genuine measurement registers for the mock platform. These
 * are stable so verifier tests can pin an "approved" mock measurement.
 */
export const MOCK_MEASUREMENTS: Record<string, string> = {
  mrtd: "mock00000000000000000000000000000000000000000000000000000000000mrtd",
  rtmr0: "00".repeat(48),
  rtmr1: "00".repeat(48),
  rtmr2: "00".repeat(48),
  rtmr3: "00".repeat(48),
};

/**
 * The canonical measurement string the verifier derives for the mock platform.
 * (Mirrors how the tdx verifier will fold MRTD+RTMRs into one value.)
 */
export const MOCK_MEASUREMENT = MOCK_MEASUREMENTS.mrtd;

/**
 * Deterministic dev/test attestation provider. Runs on any machine. Produces a
 * quote whose `reportData` is the real canonical `packReportData(bindings)` so
 * the end-to-end verifier path is exercised, but whose `platform` is `'mock'`
 * and whose measurements are fixed and obviously fake. A production verifier
 * MUST reject `platform === 'mock'`.
 */
export class MockAttestation implements AttestationProvider {
  readonly platform = "mock" as const;

  async isAvailable(): Promise<boolean> {
    // The mock provider is always available — that is the point of it.
    return true;
  }

  async generateQuote(bindings: ReportDataBindings): Promise<AttestationQuote> {
    const reportData = packReportData(bindings);

    // Deterministic fake "quote": a fixed banner followed by the report_data.
    // This is NOT a vendor-signed structure; it only has to be structurally
    // parseable by the mock verifier path.
    const banner = new TextEncoder().encode("ANTSEED-MOCK-QUOTE\0");
    const quote = new Uint8Array(banner.length + reportData.length);
    quote.set(banner, 0);
    quote.set(reportData, banner.length);

    return {
      platform: "mock",
      quote,
      reportData,
      measurements: { ...MOCK_MEASUREMENTS },
    };
  }
}

/**
 * Guard for production code paths: throws if a quote's platform is `mock`.
 * Call this anywhere a genuine quote is required (e.g. before advertising
 * attestation in production, or in a verifier configured for production).
 */
export function assertProductionPlatform(platform: string): void {
  if (platform === "mock") {
    throw new Error(
      "Refusing to use a mock attestation in a production context: " +
        "platform 'mock' is dev/test only and is never genuine.",
    );
  }
}
