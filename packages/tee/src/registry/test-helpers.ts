import {
  generateKeyPairSync,
  sign as cryptoSign,
  createPublicKey,
  type KeyObject,
} from "node:crypto";
import { canonicalizeSignedPayload } from "./client.js";
import type { ValidSet } from "./types.js";

/** Extract the raw 32-byte ed25519 public key from a node KeyObject (hex). */
function rawEd25519PublicKeyHex(publicKey: KeyObject): string {
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  // SPKI for ed25519 is a fixed 12-byte header + 32-byte key.
  return Buffer.from(der.subarray(der.length - 32)).toString("hex");
}

/** Generate an ed25519 keypair and return the signer hex + a signing function. */
export function newSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const signerHex = rawEd25519PublicKeyHex(publicKey);
  const sign = (set: ValidSet): string => {
    const message = canonicalizeSignedPayload(set);
    return cryptoSign(null, Buffer.from(message), privateKey).toString("hex");
  };
  return { signerHex, sign, privateKey };
}

/**
 * Build a fully-signed ValidSet from entries. Pass an existing `privateKey` to
 * sign with the SAME governance key (e.g. rollback tests that need two versions
 * from one signer); otherwise a fresh keypair is minted.
 */
export function signValidSet(
  partial: Omit<ValidSet, "signer" | "signature">,
  privateKey?: KeyObject,
): { set: ValidSet; signerHex: string; privateKey: KeyObject } {
  const key = privateKey ?? generateKeyPairSync("ed25519").privateKey;
  const signerHex = rawEd25519PublicKeyHex(createPublicKey(key));
  const unsigned: ValidSet = { ...partial, signer: signerHex, signature: "" };
  const signature = cryptoSign(
    null,
    Buffer.from(canonicalizeSignedPayload(unsigned)),
    key,
  ).toString("hex");
  return { set: { ...unsigned, signature }, signerHex, privateKey: key };
}
