import type { AttestationPlatform } from "./attestation/types.js";

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
