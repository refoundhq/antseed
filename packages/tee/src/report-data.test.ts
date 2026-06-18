import { describe, it, expect } from "vitest";
import {
  packReportData,
  recomputeReportData,
  reportDataEquals,
  REPORT_DATA_LENGTH,
} from "./report-data.js";

const PUBKEY = "02" + "ab".repeat(32); // 33-byte compressed-style hex
const NONCE = "cd".repeat(32);

describe("packReportData", () => {
  it("produces exactly 64 bytes", () => {
    const rd = packReportData({ peerPubkey: PUBKEY, nonce: NONCE });
    expect(rd.length).toBe(64);
    expect(REPORT_DATA_LENGTH).toBe(64);
  });

  it("is deterministic for the same inputs", () => {
    const a = packReportData({ peerPubkey: PUBKEY, nonce: NONCE });
    const b = packReportData({ peerPubkey: PUBKEY, nonce: NONCE });
    expect(reportDataEquals(a, b)).toBe(true);
  });

  it("recomputeReportData matches packReportData", () => {
    const a = packReportData({ peerPubkey: PUBKEY, nonce: NONCE });
    const b = recomputeReportData({ peerPubkey: PUBKEY, nonce: NONCE });
    expect(reportDataEquals(a, b)).toBe(true);
  });

  it("changes when peerPubkey changes", () => {
    const a = packReportData({ peerPubkey: PUBKEY, nonce: NONCE });
    const b = packReportData({ peerPubkey: "02" + "ac".repeat(32), nonce: NONCE });
    expect(reportDataEquals(a, b)).toBe(false);
  });

  it("changes when nonce changes", () => {
    const a = packReportData({ peerPubkey: PUBKEY, nonce: NONCE });
    const b = packReportData({ peerPubkey: PUBKEY, nonce: "ce".repeat(32) });
    expect(reportDataEquals(a, b)).toBe(false);
  });

  it("changes when an optional field is added (forward-compat fields bind)", () => {
    const a = packReportData({ peerPubkey: PUBKEY, nonce: NONCE });
    const b = packReportData({
      peerPubkey: PUBKEY,
      nonce: NONCE,
      bundleDigest: "11".repeat(32),
    });
    const c = packReportData({
      peerPubkey: PUBKEY,
      nonce: NONCE,
      configHash: "22".repeat(32),
    });
    expect(reportDataEquals(a, b)).toBe(false);
    expect(reportDataEquals(a, c)).toBe(false);
    expect(reportDataEquals(b, c)).toBe(false);
  });

  it("absent optional fields equal explicitly-empty optional fields", () => {
    const a = packReportData({ peerPubkey: PUBKEY, nonce: NONCE });
    const b = packReportData({
      peerPubkey: PUBKEY,
      nonce: NONCE,
      bundleDigest: "",
      configHash: "",
    });
    expect(reportDataEquals(a, b)).toBe(true);
  });

  it("tolerates a 0x prefix", () => {
    const a = packReportData({ peerPubkey: PUBKEY, nonce: NONCE });
    const b = packReportData({ peerPubkey: "0x" + PUBKEY, nonce: "0x" + NONCE });
    expect(reportDataEquals(a, b)).toBe(true);
  });

  it("rejects malformed hex", () => {
    expect(() => packReportData({ peerPubkey: "zz", nonce: NONCE })).toThrow();
    expect(() => packReportData({ peerPubkey: "abc", nonce: NONCE })).toThrow();
  });
});
