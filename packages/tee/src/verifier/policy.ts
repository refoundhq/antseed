import type { AttestationPlatform } from "../attestation/types.js";
import type { ClaimId, StoragePolicy, NetworkPolicy } from "../evidence/document.js";

/**
 * How the buyer treats a quote's Intel/AMD TCB status.
 *
 * - `uptodate-only`     : only an `UpToDate` (current) TCB passes. The strictest
 *                         posture; any SW-hardening / configuration warning is a
 *                         hard fail.
 * - `allow-swhardening` : `UpToDate` passes, and the acceptable-with-warning TCB
 *                         states (SWHardeningNeeded / ConfigurationNeeded /
 *                         ConfigurationAndSWHardeningNeeded) pass with a `warn`.
 *                         Out-of-date / revoked TCB is always a hard fail.
 */
export type TcbPolicy = "uptodate-only" | "allow-swhardening";

/**
 * Governance constraints the buyer applies to the loaded approved-set registry.
 * These mirror the fields the {@link RegistryClient} enforces at load time; the
 * verifier carries them so a single {@link VerificationPolicy} fully describes a
 * buyer's posture (registry + evidence).
 */
export interface RegistryPolicy {
  /**
   * Require the loaded ValidSet's `signer` to equal a pinned governance key.
   * PRODUCTION DEFAULT: true. When true the buyer MUST supply a pinned signer to
   * the registry client; an unpinned registry is rejected fail-closed (a dev-only
   * `allowUnpinnedSigner` opt-in on the client overrides this).
   */
  requireSignerPin: boolean;
  /**
   * Maximum age (seconds) of the registry's own `notAfter` window relative to
   * verification time. Informational here — `notAfter` expiry is enforced by the
   * registry client. Optional; omitted means "no extra freshness bound".
   */
  freshness?: number;
  /** Minimum acceptable ValidSet `version` (rollback floor). Optional. */
  minVersion?: number;
  /**
   * Minimum acceptable `revocationEpoch`. A set published before this epoch is
   * treated as revoked. Optional.
   */
  revocationEpoch?: number;
}

/**
 * The buyer-supplied verification policy. The verifier checks evidence against
 * THIS policy — never against a single hardcoded measurement or a single
 * platform. Any seller image on any allowed platform whose measurement is in
 * `measurementSet` (governed-approved) and whose evidence satisfies the policy
 * verifies with the same guarantee semantics. Different buyers may run stricter
 * or looser policies and verify accordingly.
 */
export interface VerificationPolicy {
  /**
   * Platforms the buyer will accept. A quote on a platform outside this set
   * fails CHECK 1 regardless of genuineness. PRODUCTION DEFAULT: `['tdx']`.
   */
  platforms: AttestationPlatform[];
  /** Require the TEE debug bit OFF. PRODUCTION DEFAULT: true. */
  requireDebugOff: boolean;
  /** TCB acceptance posture. PRODUCTION DEFAULT: `allow-swhardening`. */
  tcbPolicy: TcbPolicy;
  /**
   * The governed-approved measurements (image freedom). The verifier consults
   * this set — typically the active measurements from the loaded registry, but a
   * buyer MAY narrow it further. MANY measurements from MANY images may be
   * present: any of them satisfies CHECK 2.
   *
   * When provided, CHECK 2 passes iff the quote's canonical measurement is in
   * BOTH the registry's active approved set AND this set. When omitted, CHECK 2
   * defers entirely to the registry's approved set (the common case — the
   * registry IS the approved measurement set).
   */
  measurementSet?: Set<string>;
  /**
   * Allowed seller-bundle digests for two-tier deployments. When provided, the
   * evidence's `bundleDigest` MUST be present and in this set (additional check).
   * When omitted, the bundle-digest check is reported as "not enforced".
   */
  bundleDigestSet?: Set<string>;
  /**
   * Allowed effective-config hashes. When provided, the evidence's `configHash`
   * MUST be present and in this set (additional check). When omitted, the
   * config-hash check is reported as "not enforced".
   */
  configHashSet?: Set<string>;
  /** Require report_data to bind the connected peer's secp256k1 key. DEFAULT: true. */
  requirePeerBinding: boolean;
  /** Require report_data to bind the served ed25519 enclave key. DEFAULT: true. */
  requireEnclaveKeyBinding: boolean;
  /** Require report_data to bind the buyer's fresh nonce (replay defense). DEFAULT: true. */
  requireNonceFreshness: boolean;
  /** Registry governance constraints. */
  registry: RegistryPolicy;
  /**
   * Allow the dev/test `mock` platform to reach a `verified` (warn) verdict.
   * PRODUCTION DEFAULT: false. Independent of `platforms` — even if `mock` is in
   * `platforms`, a production verifier rejects it unless this is set.
   */
  allowMock: boolean;

  // --- launcher claims model (à-la-carte; ARCHITECTURE.md §6) ---
  /**
   * Claims the buyer REQUIRES verified to route. Routing is allowed iff every id
   * here is `claimed && verified` in the launcher evidence. Empty/omitted = the
   * buyer requires no specific claim (it still receives the full claim report).
   */
  requiredClaims?: ClaimId[];
  /** Minimum storage posture required (the listed fields must hold in the evidence policy). */
  requiredStorage?: Partial<StoragePolicy>;
  /** Minimum network posture required. */
  requiredNetwork?: Partial<NetworkPolicy>;
  /** Launcher capabilities the buyer requires (e.g. "no-operator-shell", "egress-locked"). */
  requiredCapabilities?: string[];
  /** Pinned AntSeed release key (hex ed25519). When set, approved-binary needs a valid release sig. */
  pinnedReleaseSigner?: string;
  /** Allowed binary release tags (e.g. ["stable"]). Applied to approved-binary. */
  allowedBinaryTags?: string[];
  /** Require the bound binary's version to equal this (exact pin). */
  requireBinaryVersion?: string;
}

/**
 * Sensible production defaults: TDX only, debug off, TCB up-to-date-or-warn,
 * mandatory signer pin, all three bindings required, mock rejected. A buyer
 * overrides individual fields (e.g. add `sev-snp`, tighten to `uptodate-only`,
 * supply a `bundleDigestSet`) to express a different posture.
 */
export function defaultProductionPolicy(
  over: Partial<VerificationPolicy> = {},
): VerificationPolicy {
  const policy: VerificationPolicy = {
    platforms: ["tdx"],
    requireDebugOff: true,
    tcbPolicy: "allow-swhardening",
    requirePeerBinding: true,
    requireEnclaveKeyBinding: true,
    requireNonceFreshness: true,
    registry: { requireSignerPin: true },
    allowMock: false,
    ...over,
  };
  // allowMock is a dev/test escape hatch. When set (and the caller did NOT
  // explicitly pin the platform allowlist), admit 'mock' to the platforms so a
  // mock seller can reach a verdict; genuineness still requires the allowMock
  // gate in the verifier. An explicit `platforms` override is respected as-is.
  if (policy.allowMock && over.platforms === undefined && !policy.platforms.includes("mock")) {
    policy.platforms = [...policy.platforms, "mock"];
  }
  return policy;
}
