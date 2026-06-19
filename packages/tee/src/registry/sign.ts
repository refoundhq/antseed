import {
  generateKeyPairSync,
  sign as cryptoSign,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from "node:crypto";
import { canonicalizeSignedPayload } from "./client.js";
import type { ValidSet } from "./types.js";

/**
 * Production signing helpers for the approved-code (ValidSet) registry. These
 * are the seeding-side counterpart of {@link verifyValidSetSignature}: the
 * operator who holds the registry-signer private key uses them to mint and sign
 * the approved-set document buyers pin. Kept in production code (not
 * test-helpers) so `antseed tee gen-registry-key` / `seed-registry` use the same
 * canonicalization path the buyer verifies against.
 */

/** Extract the raw 32-byte ed25519 public key from a node KeyObject (hex). */
function rawEd25519PublicKeyHex(publicKey: KeyObject): string {
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  // SPKI for ed25519 is a fixed 12-byte header + 32-byte key.
  return Buffer.from(der.subarray(der.length - 32)).toString("hex");
}

/** A freshly-generated registry signer keypair, ready to persist/print. */
export interface RegistryKeypair {
  /** Hex raw 32-byte ed25519 public key — this is what buyers PIN. */
  publicKeyHex: string;
  /** PEM (PKCS#8) private key — the operator keeps this secret. */
  privateKeyPem: string;
}

/**
 * Generate a fresh ed25519 registry-signer keypair. The public key (hex) is the
 * "approved-code authority" key buyers pin via `--tee-registry-signer`; the PKCS#8
 * PEM private key is what the operator stores and feeds back into
 * {@link signValidSetWithPrivateKey} when seeding.
 */
export function generateRegistryKeypair(): RegistryKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyHex: rawEd25519PublicKeyHex(publicKey),
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
}

/**
 * Load a registry-signer private key from a PKCS#8 PEM string and return both
 * its raw ed25519 public-key hex (the pinned signer value) and a function that
 * signs a ValidSet over the canonical payload.
 *
 * Throws if the PEM is not a valid ed25519 PKCS#8 private key.
 */
export function loadRegistrySigner(privateKeyPem: string): {
  signerHex: string;
  sign: (set: ValidSet) => string;
} {
  const privateKey = createPrivateKey({ key: privateKeyPem, format: "pem", type: "pkcs8" });
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `registry signer key must be ed25519, got '${privateKey.asymmetricKeyType ?? "unknown"}'`,
    );
  }
  // Derive the matching public key so the produced ValidSet pins the right signer.
  const signerHex = rawEd25519PublicKeyHex(createPublicKey(privateKey));
  const sign = (set: ValidSet): string => {
    const message = canonicalizeSignedPayload(set);
    return cryptoSign(null, Buffer.from(message), privateKey).toString("hex");
  };
  return { signerHex, sign };
}

/**
 * Sign a ValidSet's entries with a registry-signer PKCS#8 PEM private key,
 * stamping `signer` (derived from the key) and `signature` over the canonical
 * `{ version, entries }` payload. The returned set verifies under
 * {@link verifyValidSetSignature} against the embedded signer.
 */
export function signValidSetWithPrivateKey(
  privateKeyPem: string,
  partial: Omit<ValidSet, "signer" | "signature">,
): ValidSet {
  const { signerHex, sign } = loadRegistrySigner(privateKeyPem);
  const unsigned: ValidSet = { ...partial, signer: signerHex, signature: "" };
  const signature = sign(unsigned);
  return { ...unsigned, signature };
}
