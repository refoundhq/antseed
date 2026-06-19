import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import type { ValidSet, ApprovedBinary } from "./types.js";

/**
 * Binary approval — the check shared by the launcher's pre-exec gate (seller side:
 * "may I exec this seller binary?") and the buyer's `approved-binary` / `binary-active`
 * claims (buyer side: "is the bound binary digest an official, current release?").
 *
 * Approval is rooted in the GOVERNANCE signature over the whole {@link ValidSet}
 * (the digest is an `active`, non-revoked entry there). `pinnedReleaseSigner` adds
 * an optional second proof: the entry's `releaseSignature` over the digest must
 * verify under a buyer-pinned AntSeed release key. Fail-closed throughout.
 */

/** A binary's identity as observed: its digest, and optionally a claimed version/tag. */
export interface BinaryIdentity {
  /** Lowercase hex digest of the seller bundle/binary (0x tolerated). */
  digest: string;
  version?: string;
  tag?: string;
}

/** How strictly a binary must be approved. */
export interface BinaryApprovalOptions {
  /** Require the matched entry's version to equal this. */
  requireVersion?: string;
  /** Require the matched entry's tag to be one of these (e.g. ["stable"]). */
  allowedTags?: string[];
  /**
   * Hex raw ed25519 AntSeed release key. When set, the matched entry MUST carry a
   * `releaseSignature` that verifies over the digest under this key (provenance).
   */
  pinnedReleaseSigner?: string;
}

export interface BinaryVerdict {
  approved: boolean;
  reason: string;
  /** The approved entry that matched (only when approved). */
  matched?: ApprovedBinary;
}

function normDigest(d: string): string {
  return d.toLowerCase().replace(/^0x/, "");
}

/**
 * Pure, fail-closed approval check. Any miss / deprecation / revocation / version
 * or tag mismatch / missing-or-invalid release signature → not approved.
 */
export function verifyApprovedBinary(
  set: ValidSet,
  binary: BinaryIdentity,
  opts: BinaryApprovalOptions = {},
): BinaryVerdict {
  const digest = normDigest(binary.digest);
  if (!digest) return { approved: false, reason: "empty binary digest" };

  // Explicit kill switch wins over any `active` entry.
  if (set.revokedBinaries?.some((d) => normDigest(d) === digest)) {
    return { approved: false, reason: `binary digest ${digest} is revoked` };
  }

  const match = (set.binaries ?? []).find((b) => normDigest(b.digest) === digest);
  if (!match) {
    return {
      approved: false,
      reason: `binary digest ${digest} is not in the approved set (unsigned/unknown binary)`,
    };
  }
  if (match.status !== "active") {
    return { approved: false, reason: `binary ${match.version} (${digest}) is ${match.status}` };
  }
  if (opts.requireVersion !== undefined && match.version !== opts.requireVersion) {
    return {
      approved: false,
      reason: `binary version ${match.version} != required ${opts.requireVersion}`,
    };
  }
  if (opts.allowedTags !== undefined && !opts.allowedTags.includes(match.tag)) {
    return {
      approved: false,
      reason: `binary tag '${match.tag}' not in allowed tags [${opts.allowedTags.join(", ")}]`,
    };
  }
  if (opts.pinnedReleaseSigner !== undefined) {
    if (!match.releaseSignature) {
      return { approved: false, reason: "release signature required but the entry has none" };
    }
    if (!verifyReleaseSignature(digest, match.releaseSignature, opts.pinnedReleaseSigner)) {
      return { approved: false, reason: "release signature invalid under the pinned release key" };
    }
  }
  return {
    approved: true,
    reason: `approved binary ${match.version} (${match.tag})`,
    matched: match,
  };
}

/**
 * Verify an ed25519 release signature over the canonical digest string (the
 * lowercase, 0x-stripped hex digest, UTF-8 encoded). The signer is the raw 32-byte
 * ed25519 AntSeed release public key (hex). Returns false on any error.
 */
export function verifyReleaseSignature(
  digest: string,
  signatureHex: string,
  signerHex: string,
): boolean {
  try {
    const pub = ed25519PublicKeyFromRaw(hexToBytes(signerHex));
    return cryptoVerify(
      null,
      Buffer.from(normDigest(digest), "utf8"),
      pub,
      Buffer.from(hexToBytes(signatureHex)),
    );
  } catch {
    return false;
  }
}

/** The architecture's BinaryVerifier interface (§3), bound to one verified set. */
export interface BinaryVerifier {
  approve(binary: BinaryIdentity, opts?: BinaryApprovalOptions): BinaryVerdict;
}

export class RegistryBinaryVerifier implements BinaryVerifier {
  constructor(
    private readonly set: ValidSet,
    private readonly defaults: BinaryApprovalOptions = {},
  ) {}
  approve(binary: BinaryIdentity, opts: BinaryApprovalOptions = {}): BinaryVerdict {
    return verifyApprovedBinary(this.set, binary, { ...this.defaults, ...opts });
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
  if (raw.length !== 32) throw new Error("ed25519 public key must be 32 bytes");
  const prefix = Buffer.from([
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
  ]);
  const der = Buffer.concat([prefix, Buffer.from(raw)]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}
