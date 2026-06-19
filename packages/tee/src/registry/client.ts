import { promises as fs } from "node:fs";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import type { AttestationPlatform } from "../attestation/types.js";
import type { ValidSet, ValidSetEntry, ValidSetSignedPayload } from "./types.js";

export type { ValidSet, ValidSetEntry, ValidSetSignedPayload } from "./types.js";
export {
  generateRegistryKeypair,
  loadRegistrySigner,
  signValidSetWithPrivateKey,
  type RegistryKeypair,
} from "./sign.js";

/**
 * Canonical serialization of the signed payload. Stable key order so signer and
 * verifier hash identical bytes. (Entries are serialized in document order; the
 * signer is responsible for the order they intend to sign.)
 */
export function canonicalizeSignedPayload(set: ValidSet): Uint8Array {
  const payload: ValidSetSignedPayload = {
    version: set.version,
    entries: set.entries.map((e) => normalizeEntry(e)),
  };
  return new TextEncoder().encode(stableStringify(payload));
}

function normalizeEntry(e: ValidSetEntry): ValidSetEntry {
  // Re-emit with a fixed key order; omit undefined optional fields.
  const out: ValidSetEntry = {
    platform: e.platform,
    measurement: e.measurement,
    status: e.status,
  };
  if (e.bundleDigest !== undefined) out.bundleDigest = e.bundleDigest;
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

/** Verify an ed25519 signature over the canonical payload. Returns false on any error. */
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
 * Fail-closed: if a fresh, signature-valid set cannot be obtained, the client
 * holds NO usable set and `isApproved` returns false. It never silently falls
 * back to an empty or last-known-good set to produce a green verdict.
 *
 * Two-tier-ready: `isApproved` matches on `(platform, measurement)`; a future
 * bundle-digest check layers on the same entry shape via `bundleDigest`.
 */
export class RegistryClient {
  private set: ValidSet | undefined;
  /** Pinned governance signer (hex ed25519 pubkey). If set, loads must match it. */
  private readonly pinnedSigner: string | undefined;

  constructor(opts: { pinnedSigner?: string } = {}) {
    this.pinnedSigner = opts.pinnedSigner?.toLowerCase();
  }

  /** Load from a URL (fetch) or a local JSON file path, verify, and cache. */
  async load(source: string): Promise<void> {
    const raw = await this.fetchSource(source);
    const parsed = JSON.parse(raw) as ValidSet;
    this.loadFromObject(parsed);
  }

  /** Load from an in-memory object (e.g. tests), verify, and cache. */
  loadFromObject(set: ValidSet): void {
    if (this.pinnedSigner && set.signer.toLowerCase() !== this.pinnedSigner) {
      // Fail-closed: signer is not the pinned governance key.
      this.set = undefined;
      throw new Error(
        "RegistryClient: ValidSet signer does not match the pinned governance key.",
      );
    }
    if (!verifyValidSetSignature(set)) {
      // Fail-closed: do not cache an unverified set.
      this.set = undefined;
      throw new Error("RegistryClient: ValidSet signature verification failed.");
    }
    this.set = set;
  }

  /** True only if a verified set is cached and `(platform, measurement)` is active. */
  isApproved(platform: AttestationPlatform, measurement: string): boolean {
    if (!this.set) return false; // fail-closed: no verified set loaded
    const m = measurement.toLowerCase();
    return this.set.entries.some(
      (e) =>
        e.platform === platform &&
        e.measurement.toLowerCase() === m &&
        e.status === "active",
    );
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
