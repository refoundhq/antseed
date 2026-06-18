import {
  generateKeyPairSync,
  sign as cryptoSign,
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
  return { signerHex, sign };
}

/** Build a fully-signed ValidSet from entries using a fresh signer. */
export function signValidSet(
  partial: Omit<ValidSet, "signer" | "signature">,
): { set: ValidSet; signerHex: string } {
  const { signerHex, sign } = newSigner();
  const unsigned: ValidSet = { ...partial, signer: signerHex, signature: "" };
  const signature = sign(unsigned);
  return { set: { ...unsigned, signature }, signerHex };
}
