import { test, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  signEvidenceDocument,
  verifyEvidenceSignature,
  hashPolicy,
  canonicalizeEvidenceDocument,
  EVIDENCE_SCHEMA_LAUNCHER,
  type EvidenceDocument,
  type StoragePolicy,
} from "./document.js";

function enclaveKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubHex = (publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("hex");
  return { privateKey, pubHex };
}

function baseDoc(pubHex: string): Omit<EvidenceDocument, "enclaveSignature"> {
  return {
    schema: EVIDENCE_SCHEMA_LAUNCHER,
    claims: ["hardware-genuine", "approved-binary"],
    platform: "tdx",
    quote: "AAAA",
    measurements: { mrtd: "aa" },
    reportDataHex: "00".repeat(64),
    nonce: "abcd",
    peerPubkey: "aa".repeat(33),
    enclavePubkey: pubHex,
    antseedBinaryDigest: "bb".repeat(32),
    timestamp: 1700000000000,
  };
}

test("enclave signature verifies over the document", () => {
  const { privateKey, pubHex } = enclaveKeypair();
  const unsigned = baseDoc(pubHex);
  const doc: EvidenceDocument = { ...unsigned, enclaveSignature: signEvidenceDocument(unsigned, privateKey) };
  expect(verifyEvidenceSignature(doc)).toBe(true);
});

test("tampering ANY runtime field after signing breaks the signature", () => {
  const { privateKey, pubHex } = enclaveKeypair();
  const unsigned = baseDoc(pubHex);
  const doc: EvidenceDocument = { ...unsigned, enclaveSignature: signEvidenceDocument(unsigned, privateKey) };
  expect(verifyEvidenceSignature(doc)).toBe(true);
  expect(verifyEvidenceSignature({ ...doc, antseedBinaryDigest: "cc".repeat(32) })).toBe(false);
});

test("key substitution (attacker swaps enclavePubkey) fails", () => {
  const { privateKey, pubHex } = enclaveKeypair();
  const unsigned = baseDoc(pubHex);
  const sig = signEvidenceDocument(unsigned, privateKey);
  const other = enclaveKeypair();
  expect(verifyEvidenceSignature({ ...unsigned, enclavePubkey: other.pubHex, enclaveSignature: sig })).toBe(false);
});

test("policy hashing is canonical and order-independent", () => {
  const a: StoragePolicy = {
    memoryEncrypted: true, swapDisabled: true, ephemeralWritable: true,
    noPersistentPlaintext: true, noPromptLogs: true,
  };
  const b: StoragePolicy = {
    noPromptLogs: true, noPersistentPlaintext: true, ephemeralWritable: true,
    swapDisabled: true, memoryEncrypted: true,
  };
  expect(hashPolicy(a)).toBe(hashPolicy(b));
  expect(hashPolicy({ ...a, swapDisabled: false })).not.toBe(hashPolicy(a));
});

test("canonicalization excludes the signature field itself", () => {
  const { pubHex } = enclaveKeypair();
  const doc: EvidenceDocument = { ...baseDoc(pubHex), enclaveSignature: "deadbeef" };
  const c1 = Buffer.from(canonicalizeEvidenceDocument(doc)).toString();
  const c2 = Buffer.from(canonicalizeEvidenceDocument({ ...doc, enclaveSignature: "different" })).toString();
  expect(c1).toBe(c2);
});
