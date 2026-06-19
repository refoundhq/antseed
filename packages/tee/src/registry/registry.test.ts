import { describe, it, expect } from "vitest";
import { RegistryClient, verifyValidSetSignature } from "./client.js";
import { signValidSet } from "./test-helpers.js";
import type { ValidSet } from "./types.js";

const TDX_MEASUREMENT = "aa".repeat(48);
const DEPRECATED_MEASUREMENT = "bb".repeat(48);

function buildSet() {
  return signValidSet({
    version: 1,
    entries: [
      { platform: "tdx", measurement: TDX_MEASUREMENT, status: "active" },
      { platform: "tdx", measurement: DEPRECATED_MEASUREMENT, status: "deprecated" },
    ],
  });
}

/** A pinned RegistryClient that has loaded the standard two-entry set. */
function pinnedClient() {
  const { set, signerHex } = buildSet();
  const client = new RegistryClient({ pinnedSigner: signerHex });
  client.loadFromObject(set);
  return { client, set, signerHex };
}

describe("RegistryClient", () => {
  it("approves an active measurement after signature verification", () => {
    const { client } = pinnedClient();
    expect(client.isApproved("tdx", TDX_MEASUREMENT)).toBe(true);
    // case-insensitive measurement match
    expect(client.isApproved("tdx", TDX_MEASUREMENT.toUpperCase())).toBe(true);
  });

  it("rejects an unknown measurement", () => {
    const { client } = pinnedClient();
    expect(client.isApproved("tdx", "cc".repeat(48))).toBe(false);
  });

  it("rejects a deprecated measurement", () => {
    const { client } = pinnedClient();
    expect(client.isApproved("tdx", DEPRECATED_MEASUREMENT)).toBe(false);
  });

  it("rejects a measurement on the wrong platform", () => {
    const { client } = pinnedClient();
    expect(client.isApproved("mock", TDX_MEASUREMENT)).toBe(false);
  });

  it("approvedMeasurements returns the active set (image freedom)", () => {
    const { set, signerHex } = signValidSet({
      version: 1,
      entries: [
        { platform: "tdx", measurement: "11".repeat(48), status: "active" },
        { platform: "tdx", measurement: "22".repeat(48), status: "active" },
        { platform: "tdx", measurement: DEPRECATED_MEASUREMENT, status: "deprecated" },
        { platform: "mock", measurement: "33".repeat(48), status: "active" },
      ],
    });
    const client = new RegistryClient({ pinnedSigner: signerHex });
    client.loadFromObject(set);
    const tdx = client.approvedMeasurements("tdx");
    expect(tdx.has("11".repeat(48))).toBe(true);
    expect(tdx.has("22".repeat(48))).toBe(true);
    expect(tdx.has(DEPRECATED_MEASUREMENT)).toBe(false); // deprecated excluded
    expect(tdx.has("33".repeat(48))).toBe(false); // wrong platform
    // all platforms
    expect(client.approvedMeasurements().size).toBe(3);
  });

  it("fail-closed: a tampered signature throws and leaves no usable set", () => {
    const { set, signerHex } = buildSet();
    const tampered: ValidSet = { ...set, signature: "00".repeat(64) };
    expect(verifyValidSetSignature(tampered)).toBe(false);

    const client = new RegistryClient({ pinnedSigner: signerHex });
    expect(() => client.loadFromObject(tampered)).toThrow();
    expect(client.isApproved("tdx", TDX_MEASUREMENT)).toBe(false);
    expect(client.getValidSet()).toBeUndefined();
  });

  it("fail-closed: tampering with entries invalidates the signature", () => {
    const { set, signerHex } = buildSet();
    const tampered: ValidSet = {
      ...set,
      entries: [
        { platform: "tdx", measurement: DEPRECATED_MEASUREMENT, status: "active" },
      ],
    };
    expect(verifyValidSetSignature(tampered)).toBe(false);
    const client = new RegistryClient({ pinnedSigner: signerHex });
    expect(() => client.loadFromObject(tampered)).toThrow();
    expect(client.isApproved("tdx", DEPRECATED_MEASUREMENT)).toBe(false);
  });

  it("fail-closed: tampering with auditUrl invalidates the signature (auditUrl is signed)", () => {
    const { set, signerHex } = signValidSet({
      version: 1,
      entries: [{ platform: "tdx", measurement: TDX_MEASUREMENT, status: "active" }],
      auditUrl: "https://audits.example/real",
    });
    expect(verifyValidSetSignature(set)).toBe(true);

    // Flip the auditUrl to an attacker-controlled page without re-signing.
    const tampered: ValidSet = { ...set, auditUrl: "https://evil.example/fake" };
    expect(verifyValidSetSignature(tampered)).toBe(false);

    const client = new RegistryClient({ pinnedSigner: signerHex });
    expect(() => client.loadFromObject(tampered)).toThrow();
    expect(client.isApproved("tdx", TDX_MEASUREMENT)).toBe(false);
  });

  it("fail-closed: before any set is loaded, nothing is approved", () => {
    const client = new RegistryClient({ pinnedSigner: "ab".repeat(32) });
    expect(client.isApproved("tdx", TDX_MEASUREMENT)).toBe(false);
  });

  it("rejects a set whose signer != the pinned governance key", () => {
    const { set } = buildSet();
    const client = new RegistryClient({ pinnedSigner: "ff".repeat(32) });
    expect(() => client.loadFromObject(set)).toThrow();
    expect(client.isApproved("tdx", TDX_MEASUREMENT)).toBe(false);
  });

  it("production posture: an unpinned client refuses to load any set", () => {
    const { set } = buildSet();
    const client = new RegistryClient(); // no pinnedSigner, no allowUnpinnedSigner
    expect(() => client.loadFromObject(set)).toThrow(/signer pinning is mandatory/);
    expect(client.isApproved("tdx", TDX_MEASUREMENT)).toBe(false);
  });

  it("dev opt-in: allowUnpinnedSigner permits loading an unpinned set", () => {
    const { set } = buildSet();
    const client = new RegistryClient({ allowUnpinnedSigner: true });
    client.loadFromObject(set);
    expect(client.isApproved("tdx", TDX_MEASUREMENT)).toBe(true);
  });
});

describe("RegistryClient — governance", () => {
  it("rejects an expired set (notAfter in the past)", () => {
    const past = Math.floor(Date.parse("2020-01-01T00:00:00Z") / 1000);
    const { set, signerHex } = signValidSet({
      version: 1,
      entries: [{ platform: "tdx", measurement: TDX_MEASUREMENT, status: "active" }],
      notAfter: past,
    });
    const client = new RegistryClient({ pinnedSigner: signerHex });
    expect(() => client.loadFromObject(set)).toThrow(/expired/);
    expect(client.isApproved("tdx", TDX_MEASUREMENT)).toBe(false);
  });

  it("accepts a non-expired set and enforces notAfter against policy.nowSecs", () => {
    const notAfter = Math.floor(Date.parse("2025-01-01T00:00:00Z") / 1000);
    const { set, signerHex } = signValidSet({
      version: 1,
      entries: [{ platform: "tdx", measurement: TDX_MEASUREMENT, status: "active" }],
      notAfter,
    });
    // now BEFORE notAfter => ok
    const ok = new RegistryClient({
      pinnedSigner: signerHex,
      policy: { nowSecs: notAfter - 10 },
    });
    ok.loadFromObject(set);
    expect(ok.isApproved("tdx", TDX_MEASUREMENT)).toBe(true);

    // now AFTER notAfter => rejected
    const stale = new RegistryClient({
      pinnedSigner: signerHex,
      policy: { nowSecs: notAfter + 10 },
    });
    expect(() => stale.loadFromObject(set)).toThrow(/expired/);
  });

  it("rejects a set below the set's own minVersion", () => {
    const { set, signerHex } = signValidSet({
      version: 3,
      minVersion: 5,
      entries: [{ platform: "tdx", measurement: TDX_MEASUREMENT, status: "active" }],
    });
    const client = new RegistryClient({ pinnedSigner: signerHex });
    expect(() => client.loadFromObject(set)).toThrow(/below the minimum/);
  });

  it("rejects a set below the buyer policy's minVersion", () => {
    const { set, signerHex } = signValidSet({
      version: 2,
      entries: [{ platform: "tdx", measurement: TDX_MEASUREMENT, status: "active" }],
    });
    const client = new RegistryClient({
      pinnedSigner: signerHex,
      policy: { minVersion: 10 },
    });
    expect(() => client.loadFromObject(set)).toThrow(/below the minimum/);
  });

  it("rollback protection: rejects a lower version than last-seen", () => {
    const sameKey = signValidSet({
      version: 5,
      entries: [{ platform: "tdx", measurement: TDX_MEASUREMENT, status: "active" }],
    });
    const client = new RegistryClient({ pinnedSigner: sameKey.signerHex });
    client.loadFromObject(sameKey.set);

    // A v2 set signed by the SAME key — an attacker replaying an old version.
    const older = signValidSet(
      {
        version: 2,
        entries: [{ platform: "tdx", measurement: TDX_MEASUREMENT, status: "active" }],
      },
      sameKey.privateKey,
    );
    expect(() => client.loadFromObject(older.set)).toThrow(/rollback/);
    // Last good set is preserved? No — load throws and clears; isApproved is fail-closed.
    expect(client.isApproved("tdx", TDX_MEASUREMENT)).toBe(false);
  });

  it("revocation: a measurement on revokedMeasurements is never approved", () => {
    const { set, signerHex } = signValidSet({
      version: 1,
      entries: [{ platform: "tdx", measurement: TDX_MEASUREMENT, status: "active" }],
      revokedMeasurements: [TDX_MEASUREMENT],
    });
    const client = new RegistryClient({ pinnedSigner: signerHex });
    client.loadFromObject(set);
    // active entry, but explicitly revoked => not approved.
    expect(client.isApproved("tdx", TDX_MEASUREMENT)).toBe(false);
    expect(client.approvedMeasurements("tdx").has(TDX_MEASUREMENT)).toBe(false);
  });

  it("revocation epoch: rejects a set below the buyer's minRevocationEpoch", () => {
    const { set, signerHex } = signValidSet({
      version: 1,
      revocationEpoch: 3,
      entries: [{ platform: "tdx", measurement: TDX_MEASUREMENT, status: "active" }],
    });
    const client = new RegistryClient({
      pinnedSigner: signerHex,
      policy: { minRevocationEpoch: 5 },
    });
    expect(() => client.loadFromObject(set)).toThrow(/revocationEpoch/);
  });
});
