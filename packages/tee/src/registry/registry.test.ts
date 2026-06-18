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

describe("RegistryClient", () => {
  it("approves an active measurement after signature verification", () => {
    const { set } = buildSet();
    const client = new RegistryClient();
    client.loadFromObject(set);
    expect(client.isApproved("tdx", TDX_MEASUREMENT)).toBe(true);
    // case-insensitive measurement match
    expect(client.isApproved("tdx", TDX_MEASUREMENT.toUpperCase())).toBe(true);
  });

  it("rejects an unknown measurement", () => {
    const { set } = buildSet();
    const client = new RegistryClient();
    client.loadFromObject(set);
    expect(client.isApproved("tdx", "cc".repeat(48))).toBe(false);
  });

  it("rejects a deprecated measurement", () => {
    const { set } = buildSet();
    const client = new RegistryClient();
    client.loadFromObject(set);
    expect(client.isApproved("tdx", DEPRECATED_MEASUREMENT)).toBe(false);
  });

  it("rejects a measurement on the wrong platform", () => {
    const { set } = buildSet();
    const client = new RegistryClient();
    client.loadFromObject(set);
    expect(client.isApproved("mock", TDX_MEASUREMENT)).toBe(false);
  });

  it("fail-closed: a tampered signature throws and leaves no usable set", () => {
    const { set } = buildSet();
    const tampered: ValidSet = { ...set, signature: "00".repeat(64) };
    expect(verifyValidSetSignature(tampered)).toBe(false);

    const client = new RegistryClient();
    expect(() => client.loadFromObject(tampered)).toThrow();
    // fail-closed: nothing approved
    expect(client.isApproved("tdx", TDX_MEASUREMENT)).toBe(false);
    expect(client.getValidSet()).toBeUndefined();
  });

  it("fail-closed: tampering with entries invalidates the signature", () => {
    const { set } = buildSet();
    const tampered: ValidSet = {
      ...set,
      entries: [
        // attacker flips a deprecated entry to active
        { platform: "tdx", measurement: DEPRECATED_MEASUREMENT, status: "active" },
      ],
    };
    expect(verifyValidSetSignature(tampered)).toBe(false);
    const client = new RegistryClient();
    expect(() => client.loadFromObject(tampered)).toThrow();
    expect(client.isApproved("tdx", DEPRECATED_MEASUREMENT)).toBe(false);
  });

  it("fail-closed: before any set is loaded, nothing is approved", () => {
    const client = new RegistryClient();
    expect(client.isApproved("tdx", TDX_MEASUREMENT)).toBe(false);
  });

  it("rejects a set whose signer != the pinned governance key", () => {
    const { set } = buildSet();
    const client = new RegistryClient({ pinnedSigner: "ff".repeat(32) });
    expect(() => client.loadFromObject(set)).toThrow();
    expect(client.isApproved("tdx", TDX_MEASUREMENT)).toBe(false);
  });
});
