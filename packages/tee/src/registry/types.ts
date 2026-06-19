import type { AttestationPlatform } from "../attestation/types.js";

/** Per-entry TCB acceptance posture (mirrors the verifier's TcbPolicy). */
export type EntryTcbPolicy = "uptodate-only" | "allow-swhardening";

/**
 * One approved-code entry. The approved set keys on MEASUREMENT (and, in a
 * two-tier deployment, the bundle digest), never on operator identity — so a
 * BYOH box running an approved build verifies identically to an AntSeed box.
 *
 * The set MAY hold MANY entries from MANY images/builders on MANY platforms.
 * Anyone can build a different image and, once its measurement is added here
 * (governed-approved), buyers verify the same guarantees against it. This is
 * IMAGE FREEDOM: the set is a flat list of approved measurements, not a single
 * pinned image.
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
   * deployments. When set, a buyer policy with a bundleDigestSet can pin it.
   */
  bundleDigest?: string;
  /**
   * Optional effective-config hash pinned for this entry. Forward-compat with a
   * buyer configHashSet policy.
   */
  configHash?: string;
  /**
   * Optional per-entry TCB posture override (e.g. an entry the governance body
   * vouches for only at `uptodate-only`). Informational for buyers today; a
   * stricter buyer policy still wins.
   */
  tcbPolicy?: EntryTcbPolicy;
}

/**
 * The signed approved-version document. `signature` is an ed25519 signature by
 * `signer` over the canonicalized FULL signed payload — version, governance
 * fields, `auditUrl`, and `entries` (see {@link ValidSetSignedPayload}).
 *
 * Governance fields (`notAfter`, `minVersion`, `revocationEpoch`,
 * `revokedMeasurements`) are all INSIDE the signed payload, so none of them is
 * tamperable independently of the signature.
 */
export interface ValidSet {
  /**
   * Monotonic content version of this set. Buyers reject a cached set whose
   * version is LOWER than the last-seen version (rollback protection).
   */
  version: number;
  entries: ValidSetEntry[];
  /** Hex-encoded ed25519 public key of the governance signer (the pinned key). */
  signer: string;
  /** Hex-encoded ed25519 signature over the canonical full payload. */
  signature: string;
  /** Optional URL of the published audit backing these measurements (#2/#3). NOW SIGNED. */
  auditUrl?: string;
  /**
   * Optional expiry: unix seconds after which buyers MUST reject this set
   * (forces governance to re-publish, bounding staleness). Omitted = no expiry.
   */
  notAfter?: number;
  /**
   * Optional rollback floor: buyers reject a set whose `version` is below this.
   * Lets governance retire old sets even from a fresh-install buyer.
   */
  minVersion?: number;
  /**
   * Optional monotonic revocation epoch. A buyer policy may require a minimum
   * epoch; a set below it is treated as revoked. Bumped when measurements are
   * pulled.
   */
  revocationEpoch?: number;
  /**
   * Optional explicit revocation list: measurements that are revoked regardless
   * of any `active` entry (belt-and-suspenders kill switch). Lowercase hex.
   */
  revokedMeasurements?: string[];
}

/**
 * The canonical payload that {@link ValidSet.signature} covers. Holds EVERY
 * field except `signer`/`signature` themselves, so signing and verification hash
 * the exact same bytes and no governance field (including `auditUrl`) can be
 * tampered without breaking the signature.
 */
export interface ValidSetSignedPayload {
  version: number;
  entries: ValidSetEntry[];
  auditUrl?: string;
  notAfter?: number;
  minVersion?: number;
  revocationEpoch?: number;
  revokedMeasurements?: string[];
}
