import { describe, it, expect } from "vitest";
import {
  packReportData,
  recomputeReportData,
  reportDataEquals,
  REPORT_DATA_LENGTH,
} from "./report-data.js";

const PUBKEY = "02" + "ab".repeat(32); // 33-byte compressed-style secp256k1 hex
const ENCLAVE = "ed".repeat(44); // ed25519 spki/der-style hex (length irrelevant to packing)
const NONCE = "cd".repeat(32);

describe("packReportData", () => {
  it("produces exactly 64 bytes", () => {
    const rd = packReportData({ peerPubkey: PUBKEY, enclavePubkey: ENCLAVE, nonce: NONCE });
    expect(rd.length).toBe(64);
    expect(REPORT_DATA_LENGTH).toBe(64);
  });

  it("is deterministic for the same inputs", () => {
    const a = packReportData({ peerPubkey: PUBKEY, enclavePubkey: ENCLAVE, nonce: NONCE });
    const b = packReportData({ peerPubkey: PUBKEY, enclavePubkey: ENCLAVE, nonce: NONCE });
    expect(reportDataEquals(a, b)).toBe(true);
  });

  it("recomputeReportData matches packReportData", () => {
    const a = packReportData({ peerPubkey: PUBKEY, enclavePubkey: ENCLAVE, nonce: NONCE });
    const b = recomputeReportData({ peerPubkey: PUBKEY, enclavePubkey: ENCLAVE, nonce: NONCE });
    expect(reportDataEquals(a, b)).toBe(true);
  });

  it("changes when peerPubkey changes", () => {
    const a = packReportData({ peerPubkey: PUBKEY, enclavePubkey: ENCLAVE, nonce: NONCE });
    const b = packReportData({ peerPubkey: "02" + "ac".repeat(32), enclavePubkey: ENCLAVE, nonce: NONCE });
    expect(reportDataEquals(a, b)).toBe(false);
  });

  it("changes when enclavePubkey changes (binds the evidence-signing key)", () => {
    const a = packReportData({ peerPubkey: PUBKEY, enclavePubkey: ENCLAVE, nonce: NONCE });
    const b = packReportData({ peerPubkey: PUBKEY, enclavePubkey: "ee".repeat(44), nonce: NONCE });
    expect(reportDataEquals(a, b)).toBe(false);
  });

  it("does not conflate peerPubkey and enclavePubkey (length-prefixing)", () => {
    // Swapping the two keys must produce a different commitment.
    const a = packReportData({ peerPubkey: PUBKEY, enclavePubkey: ENCLAVE, nonce: NONCE });
    const b = packReportData({ peerPubkey: ENCLAVE, enclavePubkey: PUBKEY, nonce: NONCE });
    expect(reportDataEquals(a, b)).toBe(false);
  });

  it("changes when nonce changes", () => {
    const a = packReportData({ peerPubkey: PUBKEY, enclavePubkey: ENCLAVE, nonce: NONCE });
    const b = packReportData({ peerPubkey: PUBKEY, enclavePubkey: ENCLAVE, nonce: "ce".repeat(32) });
    expect(reportDataEquals(a, b)).toBe(false);
  });

  it("changes when an optional field is added (forward-compat fields bind)", () => {
    const a = packReportData({ peerPubkey: PUBKEY, enclavePubkey: ENCLAVE, nonce: NONCE });
    const b = packReportData({
      peerPubkey: PUBKEY,
      enclavePubkey: ENCLAVE,
      nonce: NONCE,
      bundleDigest: "11".repeat(32),
    });
    const c = packReportData({
      peerPubkey: PUBKEY,
      enclavePubkey: ENCLAVE,
      nonce: NONCE,
      configHash: "22".repeat(32),
    });
    expect(reportDataEquals(a, b)).toBe(false);
    expect(reportDataEquals(a, c)).toBe(false);
    expect(reportDataEquals(b, c)).toBe(false);
  });

  it("absent optional fields equal explicitly-empty optional fields", () => {
    const a = packReportData({ peerPubkey: PUBKEY, enclavePubkey: ENCLAVE, nonce: NONCE });
    const b = packReportData({
      peerPubkey: PUBKEY,
      enclavePubkey: ENCLAVE,
      nonce: NONCE,
      bundleDigest: "",
      configHash: "",
    });
    expect(reportDataEquals(a, b)).toBe(true);
  });

  it("tolerates a 0x prefix", () => {
    const a = packReportData({ peerPubkey: PUBKEY, enclavePubkey: ENCLAVE, nonce: NONCE });
    const b = packReportData({
      peerPubkey: "0x" + PUBKEY,
      enclavePubkey: "0x" + ENCLAVE,
      nonce: "0x" + NONCE,
    });
    expect(reportDataEquals(a, b)).toBe(true);
  });

  it("rejects malformed hex", () => {
    expect(() => packReportData({ peerPubkey: "zz", enclavePubkey: ENCLAVE, nonce: NONCE })).toThrow();
    expect(() => packReportData({ peerPubkey: "abc", enclavePubkey: ENCLAVE, nonce: NONCE })).toThrow();
    expect(() => packReportData({ peerPubkey: PUBKEY, enclavePubkey: "zz", nonce: NONCE })).toThrow();
  });
});
