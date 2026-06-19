import type { AttestationPlatform, AttestationProvider } from "./attestation/types.js";
import { createAttestationProvider, TdxAttestation } from "./attestation/index.js";

/**
 * Seller-side TEE configuration. Mirrors the `tee?` field added to
 * `SellerCLIConfig`. The operator's only required knob is `enabled`; everything
 * else is autodetected or defaulted.
 */
export interface TeeSellerConfig {
  /** Enable TEE attestation: load @antseed/tee, expose evidence endpoints, advertise. */
  enabled: boolean;
  /** Force a platform; default is autodetect from sysfs. 'mock' is dev-only. */
  platform?: AttestationPlatform;
  /**
   * Content digest of the running image (forward-compat). In a two-tier
   * deployment this is computed by the base over the signed bundle, not set by
   * the operator. Unused by the MVP single-tier flow.
   */
  imageDigest?: string;
  /**
   * Where the verifier-side approved set lives (also published to buyers).
   * Defaults to the AntSeed well-known endpoint when omitted.
   */
  registryUrl?: string;
}

/**
 * Resolve the attestation provider a seller should run with.
 *
 * - An explicit `config.platform` is honored verbatim (operator opt-in,
 *   including the dev-only `mock`).
 * - Otherwise autodetect: use real TDX when a TDX kernel interface is present
 *   (the GCP TDX VM case), else fall back to `mock` for local development.
 *
 * Returns the platform actually selected alongside the provider so the caller
 * can log/advertise it and refuse to announce `mock` in production.
 */
export async function resolveSellerAttestation(
  config: Pick<TeeSellerConfig, "platform">,
): Promise<{ platform: AttestationPlatform; provider: AttestationProvider }> {
  if (config.platform) {
    return {
      platform: config.platform,
      provider: createAttestationProvider(config.platform),
    };
  }
  const tdx = new TdxAttestation();
  if (await tdx.isAvailable()) {
    return { platform: "tdx", provider: tdx };
  }
  return { platform: "mock", provider: createAttestationProvider("mock") };
}
