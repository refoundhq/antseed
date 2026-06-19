import { describe, it, expect } from "vitest";
import { MockAttestation, MOCK_MEASUREMENT } from "../attestation/mock.js";
import { RegistryClient } from "../registry/client.js";
import { signValidSet } from "../registry/test-helpers.js";
import type { ValidSetEntry } from "../registry/types.js";
import { verifySeller, defaultProductionPolicy } from "./verify.js";
import type { VerificationPolicy } from "./policy.js";

const PEER_PUBKEY = "02" + "1f".repeat(32);
const ENCLAVE_PUBKEY = "ed".repeat(44);
const NONCE = "9a".repeat(32);

// A policy that permits the dev-only mock platform so the structural end-to-end
// path can be exercised without hardware. Production defaults reject mock.
function mockPolicy(over: Partial<VerificationPolicy> = {}): VerificationPolicy {
  return defaultProductionPolicy({ platforms: ["mock"], allowMock: true, ...over });
}

function registryWith(entries: ValidSetEntry[]): RegistryClient {
  const { set, signerHex } = signValidSet({ version: 1, entries });
  const client = new RegistryClient({ pinnedSigner: signerHex });
  client.loadFromObject(set);
  return client;
}

function approvedRegistry(): RegistryClient {
  return registryWith([
    { platform: "mock", measurement: MOCK_MEASUREMENT, status: "active" },
  ]);
}

async function mockQuote(
  peerPubkey = PEER_PUBKEY,
  enclavePubkey = ENCLAVE_PUBKEY,
  nonce = NONCE,
) {
  const att = new MockAttestation();
  return att.generateQuote({ peerPubkey, enclavePubkey, nonce });
}

function statusOf(result: { checks: { id: number; status: string }[] }, id: number) {
  return result.checks.find((c) => c.id === id)?.status;
}

describe("verifySeller (mock end-to-end)", () => {
  it("verifies a well-formed mock seller under a mock-allowing policy", async () => {
    const quote = await mockQuote();
    const result = verifySeller({
      quote,
      connectedPeerPubkey: PEER_PUBKEY,
      enclavePubkey: ENCLAVE_PUBKEY,
      nonce: NONCE,
      registry: approvedRegistry(),
      policy: mockPolicy(),
    });
    expect(result.verdict).toBe("verified");
    // Check 1 is a warn for mock (genuine TEE not proven), 2 and 3 pass.
    expect(statusOf(result, 1)).toBe("warn");
    expect(statusOf(result, 2)).toBe("pass");
    expect(statusOf(result, 3)).toBe("pass");
    expect(result.notProven.length).toBeGreaterThanOrEqual(5);
  });

  it("fails under the default production policy (mock platform not allowed)", async () => {
    const quote = await mockQuote();
    const result = verifySeller({
      quote,
      connectedPeerPubkey: PEER_PUBKEY,
      enclavePubkey: ENCLAVE_PUBKEY,
      nonce: NONCE,
      registry: approvedRegistry(),
      // no policy => defaultProductionPolicy: platforms ['tdx'], allowMock false
    });
    expect(result.verdict).toBe("failed");
    expect(statusOf(result, 1)).toBe("fail");
  });

  it("fails when mock platform is allowed but allowMock is false", async () => {
    const quote = await mockQuote();
    const result = verifySeller({
      quote,
      connectedPeerPubkey: PEER_PUBKEY,
      enclavePubkey: ENCLAVE_PUBKEY,
      nonce: NONCE,
      registry: approvedRegistry(),
      policy: mockPolicy({ allowMock: false }),
    });
    expect(result.verdict).toBe("failed");
    expect(statusOf(result, 1)).toBe("fail");
  });

  it("CHECK 3 fails when the connected peer pubkey is tampered", async () => {
    const quote = await mockQuote();
    const result = verifySeller({
      quote,
      connectedPeerPubkey: "02" + "20".repeat(32), // different key than attested
      enclavePubkey: ENCLAVE_PUBKEY,
      nonce: NONCE,
      registry: approvedRegistry(),
      policy: mockPolicy(),
    });
    expect(result.verdict).toBe("failed");
    expect(statusOf(result, 3)).toBe("fail");
    // measurement still approved, quote still structurally valid
    expect(statusOf(result, 2)).toBe("pass");
  });

  it("CHECK 3 fails when the enclave (ed25519) pubkey is substituted (MITM)", async () => {
    const quote = await mockQuote();
    const result = verifySeller({
      quote,
      connectedPeerPubkey: PEER_PUBKEY,
      enclavePubkey: "ee".repeat(44), // substituted evidence-signing key
      nonce: NONCE,
      registry: approvedRegistry(),
      policy: mockPolicy(),
    });
    expect(result.verdict).toBe("failed");
    expect(statusOf(result, 3)).toBe("fail");
    expect(statusOf(result, 2)).toBe("pass");
  });

  it("CHECK 3 fails when the nonce is tampered (replay / freshness)", async () => {
    const quote = await mockQuote();
    const result = verifySeller({
      quote,
      connectedPeerPubkey: PEER_PUBKEY,
      enclavePubkey: ENCLAVE_PUBKEY,
      nonce: "00".repeat(32), // different nonce than the one in the quote
      registry: approvedRegistry(),
      policy: mockPolicy(),
    });
    expect(result.verdict).toBe("failed");
    expect(statusOf(result, 3)).toBe("fail");
  });

  it("CHECK 2 fails when the measurement is not in the approved set", async () => {
    const registry = registryWith([
      { platform: "mock", measurement: "de".repeat(32), status: "active" },
    ]);
    const quote = await mockQuote();
    const result = verifySeller({
      quote,
      connectedPeerPubkey: PEER_PUBKEY,
      enclavePubkey: ENCLAVE_PUBKEY,
      nonce: NONCE,
      registry,
      policy: mockPolicy(),
    });
    expect(result.verdict).toBe("failed");
    expect(statusOf(result, 2)).toBe("fail");
    expect(statusOf(result, 3)).toBe("pass");
  });

  it("CHECK 2 fails when the approved measurement is deprecated", async () => {
    const registry = registryWith([
      { platform: "mock", measurement: MOCK_MEASUREMENT, status: "deprecated" },
    ]);
    const quote = await mockQuote();
    const result = verifySeller({
      quote,
      connectedPeerPubkey: PEER_PUBKEY,
      enclavePubkey: ENCLAVE_PUBKEY,
      nonce: NONCE,
      registry,
      policy: mockPolicy(),
    });
    expect(result.verdict).toBe("failed");
    expect(statusOf(result, 2)).toBe("fail");
  });
});

describe("verifySeller — policy dimensions", () => {
  it("platform not allowed: a mock quote fails when policy allows only tdx", async () => {
    const quote = await mockQuote();
    const result = verifySeller({
      quote,
      connectedPeerPubkey: PEER_PUBKEY,
      enclavePubkey: ENCLAVE_PUBKEY,
      nonce: NONCE,
      registry: approvedRegistry(),
      policy: mockPolicy({ platforms: ["tdx"] }),
    });
    expect(result.verdict).toBe("failed");
    expect(statusOf(result, 1)).toBe("fail");
    expect(result.checks[0].detail).toMatch(/not in the policy's allowed platforms/);
  });

  it("image freedom: multiple approved measurements — any one passes", async () => {
    // Three images from three builders; ours is one of them.
    const registry = registryWith([
      { platform: "mock", measurement: "11".repeat(32), status: "active" },
      { platform: "mock", measurement: MOCK_MEASUREMENT, status: "active" },
      { platform: "mock", measurement: "22".repeat(32), status: "active" },
    ]);
    const quote = await mockQuote();
    const result = verifySeller({
      quote,
      connectedPeerPubkey: PEER_PUBKEY,
      enclavePubkey: ENCLAVE_PUBKEY,
      nonce: NONCE,
      registry,
      policy: mockPolicy(),
    });
    expect(result.verdict).toBe("verified");
    expect(statusOf(result, 2)).toBe("pass");
  });

  it("policy measurementSet narrows the registry: excludes an otherwise-approved image", async () => {
    const registry = approvedRegistry(); // approves MOCK_MEASUREMENT
    const quote = await mockQuote();
    const result = verifySeller({
      quote,
      connectedPeerPubkey: PEER_PUBKEY,
      enclavePubkey: ENCLAVE_PUBKEY,
      nonce: NONCE,
      registry,
      // Buyer narrows to a DIFFERENT measurement set — registry-approved but
      // policy-excluded => CHECK 2 fails.
      policy: mockPolicy({ measurementSet: new Set(["99".repeat(32)]) }),
    });
    expect(result.verdict).toBe("failed");
    expect(statusOf(result, 2)).toBe("fail");
    expect(result.checks.find((c) => c.id === 2)?.detail).toMatch(/excluded by the buyer's measurementSet/);
  });

  it("bundleDigest policy: passes when the bundle digest is allowed", async () => {
    // The bundleDigest is bound into report_data too, so pass it on both sides.
    const att = new MockAttestation();
    const bundleDigest = "ab".repeat(32);
    const quote = await att.generateQuote({
      peerPubkey: PEER_PUBKEY,
      enclavePubkey: ENCLAVE_PUBKEY,
      nonce: NONCE,
      bundleDigest,
    });
    const result = verifySeller({
      quote,
      connectedPeerPubkey: PEER_PUBKEY,
      enclavePubkey: ENCLAVE_PUBKEY,
      nonce: NONCE,
      bundleDigest,
      registry: approvedRegistry(),
      policy: mockPolicy({ bundleDigestSet: new Set([bundleDigest]) }),
    });
    expect(result.verdict).toBe("verified");
    expect(statusOf(result, 2)).toBe("pass");
  });

  it("bundleDigest policy: fails when the evidence carries no bundleDigest", async () => {
    const quote = await mockQuote();
    const result = verifySeller({
      quote,
      connectedPeerPubkey: PEER_PUBKEY,
      enclavePubkey: ENCLAVE_PUBKEY,
      nonce: NONCE,
      registry: approvedRegistry(),
      policy: mockPolicy({ bundleDigestSet: new Set(["ab".repeat(32)]) }),
    });
    expect(result.verdict).toBe("failed");
    expect(statusOf(result, 2)).toBe("fail");
    expect(result.checks.find((c) => c.id === 2)?.detail).toMatch(/bundleDigest/);
  });

  it("configHash policy: fails when the configHash is not in the allowed set", async () => {
    const att = new MockAttestation();
    const configHash = "cd".repeat(32);
    const quote = await att.generateQuote({
      peerPubkey: PEER_PUBKEY,
      enclavePubkey: ENCLAVE_PUBKEY,
      nonce: NONCE,
      configHash,
    });
    const result = verifySeller({
      quote,
      connectedPeerPubkey: PEER_PUBKEY,
      enclavePubkey: ENCLAVE_PUBKEY,
      nonce: NONCE,
      configHash,
      registry: approvedRegistry(),
      policy: mockPolicy({ configHashSet: new Set(["ff".repeat(32)]) }),
    });
    expect(result.verdict).toBe("failed");
    expect(statusOf(result, 2)).toBe("fail");
    expect(result.checks.find((c) => c.id === 2)?.detail).toMatch(/configHash/);
  });
});
