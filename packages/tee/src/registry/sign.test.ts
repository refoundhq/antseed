import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  generateRegistryKeypair,
  loadRegistrySigner,
  signValidSetWithPrivateKey,
} from "./sign.js";
import { generateKeyPairSync } from "node:crypto";
import { RegistryClient, verifyValidSetSignature } from "./client.js";
import { verifyTdxQuote } from "../verifier/dcap.js";
import type { AttestationQuote } from "../attestation/types.js";

/**
 * Seeding-side round trip against the REAL Intel TDX quote fixture: DCAP-verify
 * the genuine sample quote, derive its canonical measurement, sign a ValidSet
 * with a registry-signer key, and prove the buyer's RegistryClient accepts that
 * measurement (and rejects a set signed by a different, unpinned signer). No
 * network, no mocks — reuses the committed dcap-qvl test vector.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "..", "verifier", "__fixtures__");
// Sample collateral is valid 2025-06-19..2025-07-19; pin inside that window.
const NOW_SECS = Math.floor(Date.parse("2025-06-20T00:00:00Z") / 1000);

function loadSampleQuote(): AttestationQuote {
  const raw = new Uint8Array(
    Buffer.from(readFileSync(join(FIX, "tdx_quote.b64"), "utf8"), "base64"),
  );
  const collateral = JSON.parse(
    readFileSync(join(FIX, "tdx_quote_collateral.json"), "utf8"),
  ) as Record<string, string>;
  return { platform: "tdx", quote: raw, reportData: new Uint8Array(0), measurements: {}, collateral };
}

describe("registry signing (real TDX fixture round trip)", () => {
  it("derives a measurement from a genuine quote and seeds a buyer-acceptable ValidSet", () => {
    // 1. DCAP-verify the genuine sample quote and extract the canonical measurement.
    const v = verifyTdxQuote(loadSampleQuote(), NOW_SECS);
    expect(v.genuine).toBe(true);
    expect(v.measurement.length).toBeGreaterThan(0);

    // 2. Operator mints a registry-signer key and signs a ValidSet for it.
    const { publicKeyHex, privateKeyPem } = generateRegistryKeypair();
    const set = signValidSetWithPrivateKey(privateKeyPem, {
      version: 1,
      entries: [{ platform: "tdx", measurement: v.measurement, status: "active" }],
    });

    // The signed set pins the signer derived from the private key.
    expect(set.signer).toBe(publicKeyHex);
    expect(verifyValidSetSignature(set)).toBe(true);

    // 3. The buyer pins that signer and accepts the seeded measurement.
    const buyer = new RegistryClient({ pinnedSigner: publicKeyHex });
    buyer.loadFromObject(set);
    expect(buyer.isApproved("tdx", v.measurement)).toBe(true);
    expect(buyer.isApproved("tdx", v.measurement.toUpperCase())).toBe(true);
    // An unrelated measurement is not approved.
    expect(buyer.isApproved("tdx", "cc".repeat(32))).toBe(false);
  });

  it("a buyer pinned to a DIFFERENT signer rejects the seeded set (fail-closed)", () => {
    const v = verifyTdxQuote(loadSampleQuote(), NOW_SECS);
    const { privateKeyPem } = generateRegistryKeypair();
    const set = signValidSetWithPrivateKey(privateKeyPem, {
      version: 1,
      entries: [{ platform: "tdx", measurement: v.measurement, status: "active" }],
    });

    // Buyer pins an unrelated governance key — load must throw and approve nothing.
    const otherPubkey = generateRegistryKeypair().publicKeyHex;
    const buyer = new RegistryClient({ pinnedSigner: otherPubkey });
    expect(() => buyer.loadFromObject(set)).toThrow();
    expect(buyer.isApproved("tdx", v.measurement)).toBe(false);
  });

  it("loadRegistrySigner derives the same signer the public key prints", () => {
    const { publicKeyHex, privateKeyPem } = generateRegistryKeypair();
    expect(loadRegistrySigner(privateKeyPem).signerHex).toBe(publicKeyHex);
  });

  it("rejects a non-ed25519 private key", () => {
    // An RSA PKCS#8 key is the wrong type for the registry signer.
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(() => loadRegistrySigner(pem)).toThrow(/ed25519/);
  });
});
