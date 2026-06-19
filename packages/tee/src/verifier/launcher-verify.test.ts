import { test, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { MockAttestation, MOCK_MEASUREMENT } from "../attestation/index.js";
import { signValidSet } from "../registry/test-helpers.js";
import { RegistryClient } from "../registry/client.js";
import type { ApprovedBinary, ValidSetEntry } from "../registry/types.js";
import {
  signEvidenceDocument,
  hashPolicy,
  stableStringify,
  EVIDENCE_SCHEMA_LAUNCHER,
  type EvidenceDocument,
  type StoragePolicy,
  type NetworkPolicy,
  type ClaimId,
} from "../evidence/document.js";
import {
  measureDigest,
  replayRtmr,
  imaLogToEvents,
  RTMR_EVENT,
  type RtmrEvent,
  type ImaEntry,
} from "../evidence/rtmr.js";
import type { AttestationPlatform } from "../attestation/types.js";
import { verifyLauncherEvidence } from "./launcher-verify.js";
import { defaultProductionPolicy, type VerificationPolicy } from "./policy.js";

const PEER = "aa".repeat(33);
const NONCE = "abcd1234";
const DIGEST = "bb".repeat(32);
const CHANNEL = "cc".repeat(32);
const ALL: ClaimId[] = [
  "hardware-genuine", "channel-key-bound", "approved-launcher", "approved-binary",
  "binary-active", "storage-policy", "network-policy", "no-operator-shell", "mem-encryption",
];
const STORAGE: StoragePolicy = {
  memoryEncrypted: true, swapDisabled: true, ephemeralWritable: true,
  noPersistentPlaintext: true, noPromptLogs: true,
};
const NETWORK: NetworkPolicy = {
  allowedEgress: ["https://openrouter.ai/api"], denyArbitraryEgress: true, dnsPinned: true,
};

interface ScenarioOpts {
  claims?: ClaimId[];
  platform?: AttestationPlatform;
  storage?: StoragePolicy;
  network?: NetworkPolicy;
  entry?: Partial<ValidSetEntry>;
  binaries?: ApprovedBinary[];
  channelPubkey?: string | null;
  badPin?: boolean;
}

async function scenario(o: ScenarioOpts = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const enclavePubkey = (publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("hex");
  const platform = o.platform ?? "mock";
  const storage = o.storage ?? STORAGE;
  const network = o.network ?? NETWORK;

  const quote = await new MockAttestation().generateQuote({ peerPubkey: PEER, enclavePubkey, nonce: NONCE });

  const unsigned: Omit<EvidenceDocument, "enclaveSignature"> = {
    schema: EVIDENCE_SCHEMA_LAUNCHER,
    claims: o.claims ?? ALL,
    platform,
    quote: Buffer.from(quote.quote).toString("base64"),
    measurements: quote.measurements,
    reportDataHex: Buffer.from(quote.reportData).toString("hex"),
    nonce: NONCE,
    peerPubkey: PEER,
    enclavePubkey,
    ...(o.channelPubkey === null ? {} : { channelPubkey: o.channelPubkey ?? CHANNEL, channelKeyAlg: "x25519" as const }),
    launcherMeasurement: MOCK_MEASUREMENT,
    launcherVersion: "1.0.0",
    antseedBinaryDigest: DIGEST,
    antseedBinaryVersion: "1.2.0",
    antseedBinaryTag: "stable",
    storagePolicy: storage,
    storagePolicyHash: hashPolicy(storage),
    networkPolicy: network,
    networkPolicyHash: hashPolicy(network),
    timestamp: 1700000000000,
  };
  const doc: EvidenceDocument = { ...unsigned, enclaveSignature: signEvidenceDocument(unsigned, privateKey) };

  const entry: ValidSetEntry = {
    platform: "mock",
    measurement: MOCK_MEASUREMENT,
    status: "active",
    storagePolicyHash: hashPolicy(STORAGE),
    networkPolicyHash: hashPolicy(NETWORK),
    capabilities: ["no-operator-shell", "egress-locked"],
    ...o.entry,
  };
  const { set, signerHex } = signValidSet({
    version: 1,
    entries: [entry],
    binaries: o.binaries ?? [{ digest: DIGEST, version: "1.2.0", tag: "stable", status: "active" }],
  });
  const registry = new RegistryClient({ pinnedSigner: o.badPin ? "00".repeat(32) : signerHex });
  try {
    registry.loadFromObject(set);
  } catch {
    /* badPin: leave registry empty (fail-closed) */
  }
  return { doc, registry };
}

const devPolicy = (over: Partial<VerificationPolicy> = {}): VerificationPolicy => ({
  ...defaultProductionPolicy({ allowMock: true }),
  ...over,
});

function claim(r: ReturnType<typeof verifyLauncherEvidence>, id: ClaimId) {
  return r.claims.find((c) => c.claim === id)!;
}

test("happy path: every attested claim verifies and required claims are satisfied", async () => {
  const { doc, registry } = await scenario();
  // mem-encryption is honestly not-proven on the mock platform (no real memory
  // encryption), so a mock-backed buyer does not require it.
  const REQUIRED = ALL.filter((c) => c !== "mem-encryption");
  const r = verifyLauncherEvidence({
    evidence: doc, connectedPeerPubkey: PEER, nonce: NONCE, registry,
    policy: devPolicy({ requiredClaims: REQUIRED, requiredStorage: { noPromptLogs: true }, requiredNetwork: { denyArbitraryEgress: true } }),
  });
  expect(r.substrate.ok).toBe(true);
  for (const id of REQUIRED) expect(claim(r, id).verdict, id).toBe("verified");
  expect(claim(r, "mem-encryption").verdict).toBe("not-proven");
  expect(r.requiredSatisfied).toBe(true);
  expect(r.verdict).toBe("verified");
});

test("à la carte: a seller may omit claims; buyer that doesn't require them still verifies", async () => {
  const { doc, registry } = await scenario({ claims: ["hardware-genuine", "approved-binary"], channelPubkey: null });
  const r = verifyLauncherEvidence({
    evidence: doc, connectedPeerPubkey: PEER, nonce: NONCE, registry,
    policy: devPolicy({ requiredClaims: ["approved-binary"] }),
  });
  expect(claim(r, "channel-key-bound").verdict).toBe("not-claimed");
  expect(claim(r, "approved-binary").verdict).toBe("verified");
  expect(r.verdict).toBe("verified");
});

test("buyer requiring a claim the seller did not make fails closed", async () => {
  const { doc, registry } = await scenario({ claims: ["hardware-genuine"], channelPubkey: null });
  const r = verifyLauncherEvidence({
    evidence: doc, connectedPeerPubkey: PEER, nonce: NONCE, registry,
    policy: devPolicy({ requiredClaims: ["channel-key-bound"] }),
  });
  expect(r.unmetRequired).toContain("channel-key-bound");
  expect(r.verdict).toBe("failed");
});

test("channel-key claimed but absent → failed", async () => {
  const { doc, registry } = await scenario({ channelPubkey: null }); // claims include channel-key-bound but no key
  const r = verifyLauncherEvidence({ evidence: doc, connectedPeerPubkey: PEER, nonce: NONCE, registry, policy: devPolicy() });
  expect(claim(r, "channel-key-bound").verdict).toBe("failed");
});

test("storage policy that fails to meet the buyer requirement → failed", async () => {
  const badStorage: StoragePolicy = { ...STORAGE, noPromptLogs: false };
  const { doc, registry } = await scenario({
    storage: badStorage,
    entry: { storagePolicyHash: hashPolicy(badStorage), networkPolicyHash: hashPolicy(NETWORK), capabilities: ["no-operator-shell"] },
  });
  const r = verifyLauncherEvidence({
    evidence: doc, connectedPeerPubkey: PEER, nonce: NONCE, registry,
    policy: devPolicy({ requiredStorage: { noPromptLogs: true } }),
  });
  expect(claim(r, "storage-policy").verdict).toBe("failed");
});

test("network policy not vouched by the approved launcher entry → not-proven", async () => {
  const { doc, registry } = await scenario({ entry: { networkPolicyHash: undefined } }); // entry omits networkPolicyHash
  const r = verifyLauncherEvidence({ evidence: doc, connectedPeerPubkey: PEER, nonce: NONCE, registry, policy: devPolicy() });
  expect(claim(r, "network-policy").verdict).toBe("not-proven");
});

test("wrong / revoked binary digest → approved-binary failed", async () => {
  const { doc, registry } = await scenario({
    binaries: [{ digest: "ff".repeat(32), version: "9.9.9", tag: "stable", status: "active" }],
  });
  const r = verifyLauncherEvidence({ evidence: doc, connectedPeerPubkey: PEER, nonce: NONCE, registry, policy: devPolicy() });
  expect(claim(r, "approved-binary").verdict).toBe("failed");
});

test("deprecated binary → approved-binary verified but binary-active failed", async () => {
  const { doc, registry } = await scenario({
    binaries: [{ digest: DIGEST, version: "1.2.0", tag: "stable", status: "deprecated" }],
  });
  const r = verifyLauncherEvidence({ evidence: doc, connectedPeerPubkey: PEER, nonce: NONCE, registry, policy: devPolicy() });
  expect(claim(r, "approved-binary").verdict).toBe("verified");
  expect(claim(r, "binary-active").verdict).toBe("failed");
});

test("tampering a runtime field after signing breaks the substrate (all runtime claims not-proven)", async () => {
  const { doc, registry } = await scenario();
  const tampered: EvidenceDocument = { ...doc, antseedBinaryDigest: "ee".repeat(32) };
  const r = verifyLauncherEvidence({ evidence: tampered, connectedPeerPubkey: PEER, nonce: NONCE, registry, policy: devPolicy({ requiredClaims: ["approved-binary"] }) });
  expect(r.substrate.ok).toBe(false);
  expect(claim(r, "approved-binary").verdict).toBe("not-proven");
  expect(r.verdict).toBe("failed");
});

test("unsupported / unimplemented platform fails closed", async () => {
  // Re-label as sev-snp (unimplemented quote verifier) and allow it in the policy:
  // the quote-genuineness dispatch fails closed, so the substrate fails.
  const { doc, registry } = await scenario();
  const sev: EvidenceDocument = { ...doc, platform: "sev-snp" };
  const r = verifyLauncherEvidence({
    evidence: sev, connectedPeerPubkey: PEER, nonce: NONCE, registry,
    policy: devPolicy({ platforms: ["sev-snp"], requiredClaims: ["hardware-genuine"] }),
  });
  expect(r.substrate.ok).toBe(false);
  // an unimplemented platform yields a non-verified verdict (not-proven: cannot even
  // confirm binding) and the required claim is unmet, so routing fails closed.
  expect(["failed", "not-proven"]).toContain(claim(r, "hardware-genuine").verdict);
  expect(r.verdict).toBe("failed");
});

test("no usable registry (bad signer pin) → registry-backed claims not-proven, fail closed", async () => {
  const { doc, registry } = await scenario({ badPin: true });
  const r = verifyLauncherEvidence({
    evidence: doc, connectedPeerPubkey: PEER, nonce: NONCE, registry,
    policy: devPolicy({ requiredClaims: ["approved-launcher"] }),
  });
  expect(claim(r, "approved-launcher").verdict).toBe("not-proven");
  expect(r.verdict).toBe("failed");
});

test("nonce mismatch (replay) breaks the binding substrate", async () => {
  const { doc, registry } = await scenario();
  const r = verifyLauncherEvidence({ evidence: doc, connectedPeerPubkey: PEER, nonce: "ff00", registry, policy: devPolicy({ requiredClaims: ["hardware-genuine"] }) });
  expect(r.substrate.ok).toBe(false);
  expect(r.verdict).toBe("failed");
});

// ---- MEASURED specific attestations (RTMR-anchored) ----

const ALL_MEASURED: ClaimId[] = ['egress-allowlisted', 'no-buyer-data-at-rest', 'known-binaries-only'];

async function measuredScenario(o: {
  network?: NetworkPolicy;
  storage?: StoragePolicy;
  imaHashes?: string[];
  knownBinaries?: string[];
  breakAnchor?: boolean;
  claims?: ClaimId[];
} = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const enclavePubkey = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('hex');
  const quote = await new MockAttestation().generateQuote({ peerPubkey: PEER, enclavePubkey, nonce: NONCE });

  const network = o.network ?? NETWORK;
  const storage = o.storage ?? STORAGE;
  const rtmrLog: RtmrEvent[] = [
    { rtmr: 3, digest: measureDigest(stableStringify(network)), eventType: RTMR_EVENT.egressPolicy },
    { rtmr: 3, digest: measureDigest(stableStringify(storage)), eventType: RTMR_EVENT.storagePolicy },
  ];
  const imaHashes = o.imaHashes ?? ['a1'.repeat(32), 'b2'.repeat(32)];
  const imaLog: ImaEntry[] = imaHashes.map((h, i) => ({ hash: h, path: `/usr/bin/p${i}` }));

  const rtmr3 = o.breakAnchor ? 'de'.repeat(48) : replayRtmr(rtmrLog, 3);
  const rtmr2 = replayRtmr(imaLogToEvents(imaLog, 2), 2);

  const unsigned: Omit<EvidenceDocument, 'enclaveSignature'> = {
    schema: EVIDENCE_SCHEMA_LAUNCHER,
    claims: o.claims ?? ['hardware-genuine', 'approved-launcher', ...ALL_MEASURED],
    platform: 'mock',
    quote: Buffer.from(quote.quote).toString('base64'),
    measurements: { ...quote.measurements, rtmr3, rtmr2 },
    reportDataHex: Buffer.from(quote.reportData).toString('hex'),
    nonce: NONCE,
    peerPubkey: PEER,
    enclavePubkey,
    launcherMeasurement: MOCK_MEASUREMENT,
    storagePolicy: storage,
    networkPolicy: network,
    rtmrLog,
    imaLog,
    imaRtmrIndex: 2,
    timestamp: 1700000000000,
  };
  const doc: EvidenceDocument = { ...unsigned, enclaveSignature: signEvidenceDocument(unsigned, privateKey) };

  const { set, signerHex } = signValidSet({
    version: 1,
    entries: [{ platform: 'mock', measurement: MOCK_MEASUREMENT, status: 'active' }],
    knownBinaries: o.knownBinaries ?? imaHashes,
  });
  const registry = new RegistryClient({ pinnedSigner: signerHex });
  registry.loadFromObject(set);
  return { doc, registry };
}

test('measured: egress + storage + known-binaries all verify when RTMR-anchored', async () => {
  const { doc, registry } = await measuredScenario();
  const r = verifyLauncherEvidence({
    evidence: doc, connectedPeerPubkey: PEER, nonce: NONCE, registry,
    policy: devPolicy({ requiredClaims: ALL_MEASURED }),
  });
  for (const id of ALL_MEASURED) expect(claim(r, id).verdict, id).toBe('verified');
  expect(r.verdict).toBe('verified');
});

test('measured: a non-anchored RTMR log fails egress + storage', async () => {
  const { doc, registry } = await measuredScenario({ breakAnchor: true });
  const r = verifyLauncherEvidence({ evidence: doc, connectedPeerPubkey: PEER, nonce: NONCE, registry, policy: devPolicy() });
  expect(claim(r, 'egress-allowlisted').verdict).toBe('failed');
  expect(claim(r, 'no-buyer-data-at-rest').verdict).toBe('failed');
});

test('measured: an egress policy that allows arbitrary egress fails the requirement', async () => {
  const open: NetworkPolicy = { ...NETWORK, denyArbitraryEgress: false };
  const { doc, registry } = await measuredScenario({ network: open });
  const r = verifyLauncherEvidence({ evidence: doc, connectedPeerPubkey: PEER, nonce: NONCE, registry, policy: devPolicy() });
  expect(claim(r, 'egress-allowlisted').verdict).toBe('failed');
});

test('known-binaries-only fails when an executed binary is not on the allowlist', async () => {
  const { doc, registry } = await measuredScenario({
    imaHashes: ['a1'.repeat(32), 'b2'.repeat(32), 'cc'.repeat(32)],
    knownBinaries: ['a1'.repeat(32), 'b2'.repeat(32)],
  });
  const r = verifyLauncherEvidence({
    evidence: doc, connectedPeerPubkey: PEER, nonce: NONCE, registry,
    policy: devPolicy({ requiredClaims: ['known-binaries-only'] }),
  });
  expect(claim(r, 'known-binaries-only').verdict).toBe('failed');
  expect(r.verdict).toBe('failed');
});

test('measured claims fall to not-proven when the launcher measurement is unapproved', async () => {
  const { doc } = await measuredScenario();
  const { set, signerHex } = signValidSet({
    version: 1,
    entries: [{ platform: 'mock', measurement: 'ee'.repeat(48), status: 'active' }],
  });
  const reg2 = new RegistryClient({ pinnedSigner: signerHex });
  reg2.loadFromObject(set);
  const r = verifyLauncherEvidence({ evidence: doc, connectedPeerPubkey: PEER, nonce: NONCE, registry: reg2, policy: devPolicy() });
  expect(claim(r, 'egress-allowlisted').verdict).toBe('not-proven');
});
