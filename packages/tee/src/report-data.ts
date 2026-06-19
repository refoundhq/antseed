import { createHash } from "node:crypto";
import type { ReportDataBindings } from "./attestation/types.js";

/**
 * Canonical `report_data` packing for AntSeed TEE attestation.
 *
 * `report_data` is the only free 64-byte field the CPU TEE hardware binds into a
 * quote. We commit to the channel/verification bindings with a SINGLE hash so
 * the whole field is consumed (no slack bytes / side channel) and there is one
 * value for the verifier to recompute.
 *
 * ## Layout (domain-separated canonical byte concatenation -> SHA-512 -> 64 bytes)
 *
 *   report_data[0:64] =
 *     SHA-512( CTX || peerPubkey || enclavePubkey || nonce || bundleDigest || configHash )
 *
 *   CTX           = ascii "antseed-tee/v1\0"  (fixed domain separation tag)
 *   peerPubkey    = raw bytes of the hex-encoded secp256k1 AntSeed peer key
 *   enclavePubkey = raw bytes of the hex-encoded ed25519 enclave evidence key
 *   nonce         = raw bytes of the hex-encoded buyer-supplied nonce
 *   bundleDigest  = raw bytes of the hex-encoded seller-bundle digest (optional)
 *   configHash    = raw bytes of the hex-encoded effective-config hash (optional)
 *
 * Binding BOTH keys is the correctness fix: `peerPubkey` anchors the quote to
 * the cryptographically-authenticated P2P channel identity, while
 * `enclavePubkey` attests the ed25519 evidence-signing key served at `/pubkey`
 * (otherwise unattested and MITM-substitutable).
 *
 * Each field is length-prefixed with a single big-endian u32 byte length so the
 * concatenation is unambiguous even though field widths can vary. Optional
 * fields, when absent, are encoded as a zero-length segment — present-but-empty
 * and absent are therefore indistinguishable by design (both contribute the same
 * length prefix), which leaves room to bind `bundleDigest` / `configHash` for
 * requirement #4 and the base/bundle split with no change to the layout rule.
 *
 * SHA-512 emits exactly 64 bytes, so the field is fully consumed with zero
 * padding.
 *
 * IMPORTANT: this is the one canonical encoder. The seller (quote generation)
 * and the buyer (verifier recompute) MUST both route through it. Do not inline
 * an alternative byte layout anywhere else.
 */

/** Fixed domain-separation context tag. Changing this is a wire-breaking change. */
export const REPORT_DATA_CTX: Uint8Array = new TextEncoder().encode(
  "antseed-tee/v1\0",
);

/** Length of the hardware report_data field, in bytes. */
export const REPORT_DATA_LENGTH = 64;

function hexToBytes(label: string, hex: string): Uint8Array {
  const normalized = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (normalized.length === 0) return new Uint8Array(0);
  if (normalized.length % 2 !== 0) {
    throw new Error(`packReportData: ${label} hex must have an even length`);
  }
  if (!/^[0-9a-fA-F]*$/.test(normalized)) {
    throw new Error(`packReportData: ${label} must be a hex string`);
  }
  const out = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Encode a u32 big-endian length prefix. */
function lengthPrefix(len: number): Uint8Array {
  const buf = new Uint8Array(4);
  buf[0] = (len >>> 24) & 0xff;
  buf[1] = (len >>> 16) & 0xff;
  buf[2] = (len >>> 8) & 0xff;
  buf[3] = len & 0xff;
  return buf;
}

function concatSegments(segments: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const s of segments) total += s.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const s of segments) {
    out.set(s, off);
    off += s.length;
  }
  return out;
}

/**
 * Pack the bindings into the canonical 64-byte report_data value.
 *
 * Both `peerPubkey` (secp256k1 channel identity) and `enclavePubkey` (ed25519
 * evidence-signing key) are bound. `bundleDigest` and `configHash` are
 * forward-compat (requirement #4 / base-bundle split) and default to empty.
 */
export function packReportData(bindings: ReportDataBindings): Uint8Array {
  const peerPubkey = hexToBytes("peerPubkey", bindings.peerPubkey);
  const enclavePubkey = hexToBytes("enclavePubkey", bindings.enclavePubkey);
  const nonce = hexToBytes("nonce", bindings.nonce);
  const bundleDigest = hexToBytes("bundleDigest", bindings.bundleDigest ?? "");
  const configHash = hexToBytes("configHash", bindings.configHash ?? "");

  const preimage = concatSegments([
    REPORT_DATA_CTX,
    lengthPrefix(peerPubkey.length),
    peerPubkey,
    lengthPrefix(enclavePubkey.length),
    enclavePubkey,
    lengthPrefix(nonce.length),
    nonce,
    lengthPrefix(bundleDigest.length),
    bundleDigest,
    lengthPrefix(configHash.length),
    configHash,
  ]);

  const digest = createHash("sha512").update(preimage).digest();
  return new Uint8Array(digest.buffer, digest.byteOffset, digest.byteLength);
}

/**
 * Verifier-side recompute helper. Identical to {@link packReportData}; exposed
 * under an intention-revealing name so verifier code reads as a recompute.
 */
export function recomputeReportData(bindings: ReportDataBindings): Uint8Array {
  return packReportData(bindings);
}

/** Constant-time-ish byte equality for two report_data candidates. */
export function reportDataEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
