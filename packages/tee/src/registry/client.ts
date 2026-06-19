import { promises as fs } from "node:fs";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import type { AttestationPlatform } from "../attestation/types.js";
import type {
  ValidSet,
  ValidSetEntry,
  ValidSetSignedPayload,
  ApprovedBinary,
} from "./types.js";
import { verifyApprovedBinary, type BinaryVerdict, type BinaryApprovalOptions } from "./binary.js";

export type { ValidSet, ValidSetEntry, ValidSetSignedPayload, ApprovedBinary } from "./types.js";
export type { EntryTcbPolicy } from "./types.js";
export {
  generateRegistryKeypair,
  loadRegistrySigner,
  signValidSetWithPrivateKey,
  type RegistryKeypair,
} from "./sign.js";

/**
 * Governance constraints a buyer applies when loading a ValidSet. All are
 * fail-closed: a violation throws and leaves NO usable set cached.
 */
export interface RegistryLoadPolicy {
  /** Minimum acceptable `version` (rollback floor on top of the set's own minVersion). */
  minVersion?: number;
  /** Minimum acceptable `revocationEpoch`; a set below this is treated as revoked. */
  minRevocationEpoch?: number;
  /** Verification time (unix seconds) for `notAfter` expiry. Defaults to wall clock. */
  nowSecs?: number;
}

/**
 * Canonical serialization of the FULL signed payload. Stable key order so signer
 * and verifier hash identical bytes. Covers version, governance fields,
 * `auditUrl`, and entries — nothing signable is left out.
 */
export function canonicalizeSignedPayload(set: ValidSet): Uint8Array {
  const payload: ValidSetSignedPayload = {
    version: set.version,
    entries: set.entries.map((e) => normalizeEntry(e)),
  };
  if (set.auditUrl !== undefined) payload.auditUrl = set.auditUrl;
  if (set.notAfter !== undefined) payload.notAfter = set.notAfter;
  if (set.minVersion !== undefined) payload.minVersion = set.minVersion;
  if (set.revocationEpoch !== undefined) payload.revocationEpoch = set.revocationEpoch;
  if (set.revokedMeasurements !== undefined) {
    payload.revokedMeasurements = set.revokedMeasurements;
  }
  if (set.binaries !== undefined) payload.binaries = set.binaries.map((b) => normalizeBinary(b));
  if (set.revokedBinaries !== undefined) payload.revokedBinaries = set.revokedBinaries;
  return new TextEncoder().encode(stableStringify(payload));
}

function normalizeEntry(e: ValidSetEntry): ValidSetEntry {
  // Re-emit with a fixed key set; omit undefined optionals. EVERY security-relevant
  // field must be listed here, else it would be served but NOT signed (tamperable).
  const out: ValidSetEntry = {
    platform: e.platform,
    measurement: e.measurement,
    status: e.status,
  };
  if (e.bundleDigest !== undefined) out.bundleDigest = e.bundleDigest;
  if (e.configHash !== undefined) out.configHash = e.configHash;
  if (e.tcbPolicy !== undefined) out.tcbPolicy = e.tcbPolicy;
  if (e.launcherVersion !== undefined) out.launcherVersion = e.launcherVersion;
  if (e.storagePolicyHash !== undefined) out.storagePolicyHash = e.storagePolicyHash;
  if (e.networkPolicyHash !== undefined) out.networkPolicyHash = e.networkPolicyHash;
  if (e.requireChannelBinding !== undefined) out.requireChannelBinding = e.requireChannelBinding;
  if (e.capabilities !== undefined) out.capabilities = e.capabilities;
  return out;
}

function normalizeBinary(b: ApprovedBinary): ApprovedBinary {
  const out: ApprovedBinary = {
    digest: b.digest,
    version: b.version,
    tag: b.tag,
    status: b.status,
  };
  if (b.releaseSignature !== undefined) out.releaseSignature = b.releaseSignature;
  return out;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(",")}}`;
}

/** Verify an ed25519 signature over the canonical full payload. Returns false on any error. */
export function verifyValidSetSignature(set: ValidSet): boolean {
  if (!set.signer || !set.signature) return false;
  try {
    const message = canonicalizeSignedPayload(set);
    const publicKey = ed25519PublicKeyFromRaw(hexToBytes(set.signer));
    return cryptoVerify(
      null,
      Buffer.from(message),
      publicKey,
      Buffer.from(hexToBytes(set.signature)),
    );
  } catch {
    return false;
  }
}

/**
 * Loads, verifies, and caches the approved-version {@link ValidSet}.
 *
 * Fail-closed: if a fresh, signature-valid, governance-passing set cannot be
 * obtained, the client holds NO usable set and `isApproved` returns false. It
 * never silently falls back to an empty or last-known-good set to produce a
 * green verdict.
 *
 * Production posture (signer pinning MANDATORY): unless `allowUnpinnedSigner` is
 * explicitly set (a dev opt-in), a client constructed WITHOUT `pinnedSigner`
 * refuses to load any set — an unpinned registry is rejected fail-closed.
 *
 * Governance enforced at load:
 *   - signature over the FULL payload (auditUrl + governance fields included);
 *   - `signer == pinnedSigner` (when pinned);
 *   - not expired (`notAfter`);
 *   - `version >= max(set.minVersion, policy.minVersion)`;
 *   - not rolled back (version >= last-seen version);
 *   - `revocationEpoch >= policy.minRevocationEpoch`;
 *   - measurements on `revokedMeasurements` are never approved.
 */
export class RegistryClient {
  private set: ValidSet | undefined;
  /** Pinned governance signer (hex ed25519 pubkey). If set, loads must match it. */
  private readonly pinnedSigner: string | undefined;
  /** Dev-only opt-in: permit loading a set without a pinned signer. */
  private readonly allowUnpinnedSigner: boolean;
  /** Buyer governance constraints applied at load. */
  private readonly policy: RegistryLoadPolicy;
  /** Highest version ever accepted by this client (rollback protection). */
  private lastSeenVersion = 0;

  constructor(
    opts: {
      pinnedSigner?: string;
      allowUnpinnedSigner?: boolean;
      policy?: RegistryLoadPolicy;
    } = {},
  ) {
    this.pinnedSigner = opts.pinnedSigner?.toLowerCase();
    this.allowUnpinnedSigner = opts.allowUnpinnedSigner ?? false;
    this.policy = opts.policy ?? {};
  }

  /** Load from a URL (fetch) or a local JSON file path, verify, and cache. */
  async load(source: string): Promise<void> {
    const raw = await this.fetchSource(source);
    const parsed = JSON.parse(raw) as ValidSet;
    this.loadFromObject(parsed);
  }

  /** Load from an in-memory object (e.g. tests), verify, and cache. */
  loadFromObject(set: ValidSet): void {
    // 0. Production posture: signer pinning is mandatory unless explicitly opted out.
    if (!this.pinnedSigner && !this.allowUnpinnedSigner) {
      throw new Error(
        "RegistryClient: signer pinning is mandatory in production — construct with " +
          "{ pinnedSigner } (or { allowUnpinnedSigner: true } for dev only).",
      );
    }
    // 1. Signer pin.
    if (this.pinnedSigner && set.signer.toLowerCase() !== this.pinnedSigner) {
      this.set = undefined;
      throw new Error(
        "RegistryClient: ValidSet signer does not match the pinned governance key.",
      );
    }
    // 2. Signature over the full payload.
    if (!verifyValidSetSignature(set)) {
      this.set = undefined;
      throw new Error("RegistryClient: ValidSet signature verification failed.");
    }
    // 3. Expiry.
    const now = this.policy.nowSecs ?? Math.floor(Date.now() / 1000);
    if (typeof set.notAfter === "number" && now >= set.notAfter) {
      this.set = undefined;
      throw new Error(
        `RegistryClient: ValidSet expired (notAfter ${set.notAfter} <= now ${now}).`,
      );
    }
    // 4. minVersion floor (the set's own AND the buyer policy's).
    const floor = Math.max(set.minVersion ?? 0, this.policy.minVersion ?? 0);
    if (set.version < floor) {
      this.set = undefined;
      throw new Error(
        `RegistryClient: ValidSet version ${set.version} is below the minimum ${floor}.`,
      );
    }
    // 5. Rollback protection: never accept a lower version than already seen.
    if (set.version < this.lastSeenVersion) {
      this.set = undefined;
      throw new Error(
        `RegistryClient: rollback rejected — version ${set.version} < last-seen ${this.lastSeenVersion}.`,
      );
    }
    // 6. Revocation epoch floor.
    if (
      typeof this.policy.minRevocationEpoch === "number" &&
      (set.revocationEpoch ?? 0) < this.policy.minRevocationEpoch
    ) {
      this.set = undefined;
      throw new Error(
        `RegistryClient: ValidSet revocationEpoch ${set.revocationEpoch ?? 0} ` +
          `is below the required minimum ${this.policy.minRevocationEpoch}.`,
      );
    }

    this.set = set;
    this.lastSeenVersion = Math.max(this.lastSeenVersion, set.version);
  }

  /**
   * True only if a verified set is cached and `(platform, measurement)` is active
   * AND not on the explicit revocation list.
   */
  isApproved(platform: AttestationPlatform, measurement: string): boolean {
    if (!this.set) return false; // fail-closed: no verified set loaded
    const m = measurement.toLowerCase();
    if (this.set.revokedMeasurements?.some((r) => r.toLowerCase() === m)) {
      return false; // explicit kill switch
    }
    return this.set.entries.some(
      (e) =>
        e.platform === platform &&
        e.measurement.toLowerCase() === m &&
        e.status === "active",
    );
  }

  /**
   * The set of active, non-revoked approved measurements (lowercase hex) for a
   * platform. This is what the verifier folds into a buyer's policy
   * `measurementSet` — image freedom is realized here: it returns EVERY approved
   * measurement, not a single pinned image.
   */
  approvedMeasurements(platform?: AttestationPlatform): Set<string> {
    const out = new Set<string>();
    if (!this.set) return out;
    const revoked = new Set(
      (this.set.revokedMeasurements ?? []).map((r) => r.toLowerCase()),
    );
    for (const e of this.set.entries) {
      if (e.status !== "active") continue;
      if (platform && e.platform !== platform) continue;
      const m = e.measurement.toLowerCase();
      if (revoked.has(m)) continue;
      out.add(m);
    }
    return out;
  }

  /**
   * Buyer-side mirror of the launcher's pre-exec gate: is the bound AntSeed seller
   * binary digest approved by the verified set (active, not revoked, version/tag
   * and optional release-signature satisfied)? Fail-closed if no set is loaded.
   */
  approveBinary(
    binary: { digest: string; version?: string; tag?: string },
    opts?: BinaryApprovalOptions,
  ): BinaryVerdict {
    if (!this.set) {
      return { approved: false, reason: "no verified ValidSet loaded (fail-closed)" };
    }
    return verifyApprovedBinary(this.set, binary, opts);
  }

  /** The verified set, or undefined if none is loaded. */
  getValidSet(): ValidSet | undefined {
    return this.set;
  }

  private async fetchSource(source: string): Promise<string> {
    if (/^https?:\/\//i.test(source)) {
      const res = await fetch(source);
      if (!res.ok) {
        throw new Error(
          `RegistryClient: failed to fetch ${source}: HTTP ${res.status}`,
        );
      }
      return res.text();
    }
    // Treat as a local file path (supports file:// too).
    const path = source.startsWith("file://") ? source.slice("file://".length) : source;
    return fs.readFile(path, "utf8");
  }
}

function hexToBytes(hex: string): Uint8Array {
  const n = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (n.length % 2 !== 0) throw new Error("invalid hex length");
  const out = new Uint8Array(n.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(n.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Wrap a 32-byte raw ed25519 public key into a node:crypto KeyObject via DER/SPKI. */
function ed25519PublicKeyFromRaw(raw: Uint8Array) {
  if (raw.length !== 32) {
    throw new Error("ed25519 public key must be 32 bytes");
  }
  // SPKI prefix for an ed25519 public key (RFC 8410): 12-byte header.
  const prefix = Buffer.from([
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
  ]);
  const der = Buffer.concat([prefix, Buffer.from(raw)]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}
