import { describe, it, expect } from "vitest";
import { MockAttestation, MOCK_MEASUREMENT } from "../attestation/mock.js";
import { RegistryClient } from "../registry/client.js";
import { signValidSet } from "../registry/test-helpers.js";
import { verifySeller } from "./verify.js";

const PEER_PUBKEY = "02" + "1f".repeat(32);
const NONCE = "9a".repeat(32);

function approvedRegistry(): RegistryClient {
  const { set } = signValidSet({
    version: 1,
    entries: [
      { platform: "mock", measurement: MOCK_MEASUREMENT, status: "active" },
    ],
  });
  const client = new RegistryClient();
  client.loadFromObject(set);
  return client;
}

async function mockQuote(peerPubkey = PEER_PUBKEY, nonce = NONCE) {
  const att = new MockAttestation();
  return att.generateQuote({ peerPubkey, nonce });
}

function statusOf(result: { checks: { id: number; status: string }[] }, id: number) {
  return result.checks.find((c) => c.id === id)?.status;
}

describe("verifySeller (mock end-to-end)", () => {
  it("verifies a well-formed mock seller with allowMock", async () => {
    const quote = await mockQuote();
    const result = verifySeller({
      quote,
      connectedPeerPubkey: PEER_PUBKEY,
      nonce: NONCE,
      registry: approvedRegistry(),
      allowMock: true,
    });
    expect(result.verdict).toBe("verified");
    // Check 1 is a warn for mock (genuine TEE not proven), 2 and 3 pass.
    expect(statusOf(result, 1)).toBe("warn");
    expect(statusOf(result, 2)).toBe("pass");
    expect(statusOf(result, 3)).toBe("pass");
    expect(result.notProven.length).toBeGreaterThanOrEqual(5);
  });

  it("fails when mock is not explicitly allowed (production posture)", async () => {
    const quote = await mockQuote();
    const result = verifySeller({
      quote,
      connectedPeerPubkey: PEER_PUBKEY,
      nonce: NONCE,
      registry: approvedRegistry(),
      // allowMock defaults to false
    });
    expect(result.verdict).toBe("failed");
    expect(statusOf(result, 1)).toBe("fail");
  });

  it("CHECK 3 fails when the connected peer pubkey is tampered", async () => {
    const quote = await mockQuote();
    const result = verifySeller({
      quote,
      connectedPeerPubkey: "02" + "20".repeat(32), // different key than attested
      nonce: NONCE,
      registry: approvedRegistry(),
      allowMock: true,
    });
    expect(result.verdict).toBe("failed");
    expect(statusOf(result, 3)).toBe("fail");
    // measurement still approved, quote still structurally valid
    expect(statusOf(result, 2)).toBe("pass");
  });

  it("CHECK 3 fails when the nonce is tampered (replay / freshness)", async () => {
    const quote = await mockQuote();
    const result = verifySeller({
      quote,
      connectedPeerPubkey: PEER_PUBKEY,
      nonce: "00".repeat(32), // different nonce than the one in the quote
      registry: approvedRegistry(),
      allowMock: true,
    });
    expect(result.verdict).toBe("failed");
    expect(statusOf(result, 3)).toBe("fail");
  });

  it("CHECK 2 fails when the measurement is not in the approved set", async () => {
    // Registry that approves a DIFFERENT measurement.
    const { set } = signValidSet({
      version: 1,
      entries: [{ platform: "mock", measurement: "de".repeat(32), status: "active" }],
    });
    const registry = new RegistryClient();
    registry.loadFromObject(set);

    const quote = await mockQuote();
    const result = verifySeller({
      quote,
      connectedPeerPubkey: PEER_PUBKEY,
      nonce: NONCE,
      registry,
      allowMock: true,
    });
    expect(result.verdict).toBe("failed");
    expect(statusOf(result, 2)).toBe("fail");
    // channel binding still holds
    expect(statusOf(result, 3)).toBe("pass");
  });

  it("CHECK 2 fails when the approved measurement is deprecated", async () => {
    const { set } = signValidSet({
      version: 1,
      entries: [
        { platform: "mock", measurement: MOCK_MEASUREMENT, status: "deprecated" },
      ],
    });
    const registry = new RegistryClient();
    registry.loadFromObject(set);

    const quote = await mockQuote();
    const result = verifySeller({
      quote,
      connectedPeerPubkey: PEER_PUBKEY,
      nonce: NONCE,
      registry,
      allowMock: true,
    });
    expect(result.verdict).toBe("failed");
    expect(statusOf(result, 2)).toBe("fail");
  });
});
