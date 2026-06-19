import { test, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { MockAttestation, MOCK_MEASUREMENT } from "../attestation/index.js";
import { signValidSet } from "../registry/test-helpers.js";
import { RegistryClient } from "../registry/client.js";
import { verifyLauncherEvidence } from "../verifier/launcher-verify.js";
import { defaultProductionPolicy } from "../verifier/policy.js";
import { buildLauncherEvidence } from "./builder.js";
import { hashPolicy, type ClaimId, type StoragePolicy, type NetworkPolicy } from "./document.js";

const PEER = "aa".repeat(33);
const NONCE = "abcd1234";
const DIGEST = "bb".repeat(32);
const STORAGE: StoragePolicy = {
  memoryEncrypted: true, swapDisabled: true, ephemeralWritable: true,
  noPersistentPlaintext: true, noPromptLogs: true,
};
const NETWORK: NetworkPolicy = {
  allowedEgress: ["https://openrouter.ai/api"], denyArbitraryEgress: true, dnsPinned: true,
};

function enclaveKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { privateKey, pubHex: (publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("hex") };
}

function registryFor(extra: Partial<Parameters<typeof signValidSet>[0]> = {}) {
  return signValidSet({
    version: 1,
    entries: [{
      platform: "mock", measurement: MOCK_MEASUREMENT, status: "active",
      storagePolicyHash: hashPolicy(STORAGE), networkPolicyHash: hashPolicy(NETWORK),
      capabilities: ["no-operator-shell"],
    }],
    binaries: [{ digest: DIGEST, version: "1.2.0", tag: "stable", status: "active" }],
    ...extra,
  });
}

test("build → verify round-trip: full claim set verifies end to end", async () => {
  const { privateKey, pubHex } = enclaveKey();
  const claims: ClaimId[] = [
    "hardware-genuine", "channel-key-bound", "approved-launcher", "approved-binary",
    "binary-active", "storage-policy", "network-policy", "no-operator-shell",
  ];
  const doc = await buildLauncherEvidence(
    {
      platform: "mock", attestation: new MockAttestation(), claims,
      peerPubkey: PEER, enclavePubkey: pubHex, enclavePrivateKey: privateKey,
      channelPubkey: "cc".repeat(32),
      launcherMeasurement: MOCK_MEASUREMENT, launcherVersion: "1.0.0",
      antseedBinary: { digest: DIGEST, version: "1.2.0", tag: "stable" },
      storagePolicy: STORAGE, networkPolicy: NETWORK,
      timestamp: 1700000000000,
    },
    NONCE,
  );

  const { set, signerHex } = registryFor();
  const registry = new RegistryClient({ pinnedSigner: signerHex });
  registry.loadFromObject(set);

  const r = verifyLauncherEvidence({
    evidence: doc, connectedPeerPubkey: PEER, nonce: NONCE, registry,
    policy: { ...defaultProductionPolicy({ allowMock: true }), requiredClaims: claims },
  });
  expect(r.substrate.ok).toBe(true);
  for (const id of claims) expect(r.claims.find((c) => c.claim === id)!.verdict, id).toBe("verified");
  expect(r.verdict).toBe("verified");
});

test("minimal seller (only hardware-genuine) builds a lean doc that still verifies", async () => {
  const { privateKey, pubHex } = enclaveKey();
  const doc = await buildLauncherEvidence(
    {
      platform: "mock", attestation: new MockAttestation(), claims: ["hardware-genuine"],
      peerPubkey: PEER, enclavePubkey: pubHex, enclavePrivateKey: privateKey,
      timestamp: 1700000000000,
    },
    NONCE,
  );
  // a lean doc omits the runtime fields entirely
  expect(doc.channelPubkey).toBeUndefined();
  expect(doc.antseedBinaryDigest).toBeUndefined();
  expect(doc.storagePolicy).toBeUndefined();

  const { set, signerHex } = registryFor();
  const registry = new RegistryClient({ pinnedSigner: signerHex });
  registry.loadFromObject(set);

  const r = verifyLauncherEvidence({
    evidence: doc, connectedPeerPubkey: PEER, nonce: NONCE, registry,
    policy: { ...defaultProductionPolicy({ allowMock: true }), requiredClaims: ["hardware-genuine"] },
  });
  expect(r.claims.find((c) => c.claim === "hardware-genuine")!.verdict).toBe("verified");
  expect(r.claims.find((c) => c.claim === "approved-binary")!.verdict).toBe("not-claimed");
  expect(r.verdict).toBe("verified");
});
