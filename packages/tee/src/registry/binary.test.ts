import { test, expect } from "vitest";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { signValidSet } from "./test-helpers.js";
import { RegistryClient } from "./client.js";
import { verifyApprovedBinary, RegistryBinaryVerifier } from "./binary.js";
import type { ApprovedBinary, ValidSet } from "./types.js";

const DIGEST = "ab".repeat(32); // 64-hex approved digest
const OTHER = "cd".repeat(32);

function baseBinaries(): ApprovedBinary[] {
  return [{ digest: DIGEST, version: "1.2.0", tag: "stable", status: "active" }];
}

/** Raw 32-byte ed25519 public key hex from a keypair (the pinned-signer shape). */
function rawPubHex(publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"]): string {
  return Buffer.from(
    (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32),
  ).toString("hex");
}

test("valid approved binary is accepted", () => {
  const { set } = signValidSet({ version: 1, entries: [], binaries: baseBinaries() });
  const v = verifyApprovedBinary(set, { digest: DIGEST });
  expect(v.approved).toBe(true);
  expect(v.matched?.version).toBe("1.2.0");
});

test("unknown / unsigned binary digest is rejected", () => {
  const { set } = signValidSet({ version: 1, entries: [], binaries: baseBinaries() });
  const v = verifyApprovedBinary(set, { digest: OTHER });
  expect(v.approved).toBe(false);
  expect(v.reason).toMatch(/not in the approved set/);
});

test("deprecated binary is rejected", () => {
  const { set } = signValidSet({
    version: 1,
    entries: [],
    binaries: [{ digest: DIGEST, version: "1.2.0", tag: "stable", status: "deprecated" }],
  });
  const v = verifyApprovedBinary(set, { digest: DIGEST });
  expect(v.approved).toBe(false);
  expect(v.reason).toMatch(/deprecated/);
});

test("revoked binary is rejected even with an active entry present", () => {
  const { set } = signValidSet({
    version: 1,
    entries: [],
    binaries: baseBinaries(),
    revokedBinaries: [DIGEST],
  });
  const v = verifyApprovedBinary(set, { digest: DIGEST });
  expect(v.approved).toBe(false);
  expect(v.reason).toMatch(/revoked/);
});

test("version and tag policy are enforced", () => {
  const { set } = signValidSet({ version: 1, entries: [], binaries: baseBinaries() });
  expect(verifyApprovedBinary(set, { digest: DIGEST }, { requireVersion: "9.9.9" }).approved).toBe(false);
  expect(verifyApprovedBinary(set, { digest: DIGEST }, { allowedTags: ["beta"] }).approved).toBe(false);
  expect(verifyApprovedBinary(set, { digest: DIGEST }, { allowedTags: ["stable"] }).approved).toBe(true);
});

test("release signature: missing-but-required rejected; valid accepted; wrong key rejected", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const releaseSigner = rawPubHex(publicKey);
  const sig = cryptoSign(null, Buffer.from(DIGEST, "utf8"), privateKey).toString("hex");

  const signed = signValidSet({
    version: 1,
    entries: [],
    binaries: [{ digest: DIGEST, version: "1.2.0", tag: "stable", status: "active", releaseSignature: sig }],
  }).set;
  const unsigned = signValidSet({ version: 1, entries: [], binaries: baseBinaries() }).set;

  expect(verifyApprovedBinary(unsigned, { digest: DIGEST }, { pinnedReleaseSigner: releaseSigner }).approved).toBe(false);
  expect(verifyApprovedBinary(signed, { digest: DIGEST }, { pinnedReleaseSigner: releaseSigner }).approved).toBe(true);

  const wrongKey = rawPubHex(generateKeyPairSync("ed25519").publicKey);
  expect(verifyApprovedBinary(signed, { digest: DIGEST }, { pinnedReleaseSigner: wrongKey }).approved).toBe(false);
});

test("tampering the approved binaries after signing breaks the governance signature", () => {
  const { set, signerHex } = signValidSet({ version: 1, entries: [], binaries: baseBinaries() });
  // Attacker swaps the approved digest to their own binary; signature now invalid.
  const tampered: ValidSet = { ...set, binaries: [{ ...set.binaries![0]!, digest: OTHER }] };
  const buyer = new RegistryClient({ pinnedSigner: signerHex });
  expect(() => buyer.loadFromObject(tampered)).toThrow(/signature/i);
});

test("RegistryClient.approveBinary mirrors the gate and is fail-closed without a loaded set", () => {
  const noSet = new RegistryClient({ pinnedSigner: "00".repeat(32) });
  expect(noSet.approveBinary({ digest: DIGEST }).approved).toBe(false);

  const { set, signerHex } = signValidSet({ version: 1, entries: [], binaries: baseBinaries() });
  const buyer = new RegistryClient({ pinnedSigner: signerHex });
  buyer.loadFromObject(set);
  expect(buyer.approveBinary({ digest: DIGEST }).approved).toBe(true);
  expect(buyer.approveBinary({ digest: OTHER }).approved).toBe(false);
});

test("RegistryBinaryVerifier applies default options", () => {
  const { set } = signValidSet({ version: 1, entries: [], binaries: baseBinaries() });
  const v = new RegistryBinaryVerifier(set, { allowedTags: ["stable"] });
  expect(v.approve({ digest: DIGEST }).approved).toBe(true);
  expect(v.approve({ digest: DIGEST }, { allowedTags: ["beta"] }).approved).toBe(false);
});
