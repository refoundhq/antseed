import type { AttestationPlatform } from "../attestation/types.js";

/**
 * One approved-code entry. The approved set keys on MEASUREMENT (and, in a
 * two-tier deployment, the bundle digest), never on operator identity — so a
 * BYOH box running an approved build verifies identically to an AntSeed box.
 */
export interface ValidSetEntry {
  /** Platform this measurement is valid on. */
  platform: AttestationPlatform;
  /** Hex measurement (TDX: MRTD/RTMR-derived; SEV-SNP: MEASUREMENT; mock: fixed). */
  measurement: string;
  /** `active` = trusted; `deprecated` = kill-switched (no longer trusted). */
  status: "active" | "deprecated";
  /**
   * Optional hot-swappable seller-bundle digest D for two-tier (base+bundle)
   * deployments. Forward-compat; unused by the MVP single-tier check.
   */
  bundleDigest?: string;
}

/**
 * The signed approved-version document. `signature` is an ed25519 signature by
 * `signer` over the canonicalized `{ version, entries }` payload.
 */
export interface ValidSet {
  /** Monotonic schema/content version of this set. */
  version: number;
  entries: ValidSetEntry[];
  /** Hex-encoded ed25519 public key of the governance signer (the pinned key). */
  signer: string;
  /** Hex-encoded ed25519 signature over the canonical payload. */
  signature: string;
  /** Optional URL of the published audit backing these measurements (#2/#3). */
  auditUrl?: string;
}

/**
 * The canonical payload that {@link ValidSet.signature} covers. Kept separate
 * from `signer`/`signature` so signing and verification hash the exact same
 * bytes regardless of key-ordering in the source JSON.
 */
export interface ValidSetSignedPayload {
  version: number;
  entries: ValidSetEntry[];
}
