import type { AttestationPlatform, AttestationProvider } from "./types.js";
import { MockAttestation } from "./mock.js";
import { TdxAttestation } from "./tdx.js";

export type {
  AttestationPlatform,
  AttestationProvider,
  AttestationQuote,
  ReportDataBindings,
} from "./types.js";
export { MockAttestation, MOCK_MEASUREMENTS, MOCK_MEASUREMENT, assertProductionPlatform } from "./mock.js";
export { TdxAttestation, parseTdxMeasurements } from "./tdx.js";
export type { TdxAttestationOptions } from "./tdx.js";
export {
  fetchTdxCollateral,
  normalizeCollateral,
  clearCollateralCache,
} from "./collateral.js";
export type { WireCollateral } from "./collateral.js";

/**
 * Construct an attestation provider for the given platform.
 *
 * If `platform` is omitted, callers should run autodetection (probe sysfs) —
 * for the MVP we keep this explicit and default to `mock` so dev/test does not
 * require TEE hardware. Selecting `mock` outside dev/test is rejected at use
 * time by the verifier and by `assertProductionPlatform`.
 *
 * `sev-snp` is part of the platform type (forward-compat for AMD SEV-SNP) but
 * not yet wired here; requesting it throws until the SevAttestation provider
 * lands.
 */
export function createAttestationProvider(
  platform: AttestationPlatform = "mock",
): AttestationProvider {
  switch (platform) {
    case "tdx":
      return new TdxAttestation();
    case "mock":
      return new MockAttestation();
    case "sev-snp":
      // TODO(tee): add SevAttestation (/dev/sev-guest SNP_GET_REPORT ioctl).
      throw new Error(
        "createAttestationProvider: 'sev-snp' not yet implemented in MVP.",
      );
    default: {
      const _exhaustive: never = platform;
      throw new Error(`Unknown attestation platform: ${String(_exhaustive)}`);
    }
  }
}
