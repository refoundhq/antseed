# AntSeed TEE — Launcher Attestation Architecture

This is the design contract for `@antseed/tee` and the seller/buyer TEE paths. It
is **one whole design**, not an increment on a shipped product — these branches
are unreleased, so the schemas below are the schemas, and the only reason a
"schema version" field exists is wire hygiene, not backward-marketing.

## 1. Trust model — why a *launcher*, not an image

Intel TDX (and SEV-SNP, Nitro, …) protect guest memory from the **host /
hypervisor**. They do **not** protect the broker from **root inside the guest**.
A seller operator with a shell in the guest can read broker memory, swap the
binary, rewrite firewall rules, or terminate the buyer's transport and read
plaintext. Therefore the hardware quote alone ("genuine TDX, debug off, TCB ok,
measurement X") is **necessary but not sufficient** for any confidentiality claim.

The trusted boundary is the **launcher/runtime**: a small, measured component that
boots inside the TEE and is the *only* entrypoint. The launcher:

- verifies the AntSeed seller binary (digest + version/tag + release signature)
  against a signed approved set **before exec**, and refuses modified / unsigned /
  untagged / deprecated / revoked binaries;
- generates and **custodies** the in-TEE keys (evidence-signing + channel), never
  exporting them to the operator;
- enforces (or, where it can only attest, measures) the **storage** and **network**
  policy;
- emits a **hardware-neutral evidence document** binding all of the above.

"Operator cannot read the key or plaintext" is credible **only** because the
approved launcher measurement attests a runtime that gives the operator **no
shell** (no sshd, launcher as init/PID-controlled, ephemeral writable state). The
buyer enforces this by requiring the launcher measurement to be in the approved
set. On a runtime that does *not* attest operator-exclusion, the buyer fails
closed (or labels confidentiality **not proven** — see §9). This is the honesty
boundary: we never claim more than the measurement + policy actually back.

## 2. Two attestation layers (design requirement A)

The buyer verifies **both**, and fails closed if either is missing:

| Layer | Rooted in | Proves |
|-------|-----------|--------|
| **Hardware / platform** | the silicon vendor's quote + DCAP/KDS collateral | genuine TEE, debug off, acceptable TCB, memory-encryption semantics, the **launcher measurement** that booted |
| **Launcher / runtime** | the in-enclave key (bound by the hardware layer) signing the evidence doc | approved **AntSeed binary** digest+version, **storage** policy, **network** policy, **channel-key** binding, config/bundle digests |

The bridge between them is the in-enclave **ed25519 evidence key**: `report_data`
(hardware-bound) commits to that key + the peer key + the buyer nonce; that key
then **signs the evidence document**, so every runtime field inherits hardware-
rooted integrity without enlarging the 64-byte `report_data`.

## 3. The five interfaces (design requirement C)

All in `@antseed/tee`. TDX is the first real implementation; every other platform
returns a fail-closed stub (`NotImplemented`) so adding one is additive, never a
silent pass.

```ts
// Hardware layer — one per platform.
interface PlatformAttestor {
  readonly platform: AttestationPlatform;
  isAvailable(): Promise<boolean>;
  generateQuote(reportData: Uint8Array): Promise<AttestationQuote>;  // binds report_data
  // buyer side:
  verifyQuote(quote, collateral, nowSecs): QuoteGenuineness;          // genuine/debug/TCB/measurement/memEnc
}

// Runtime layer — produces the measured policy + launcher identity the seller runs under.
interface RuntimePolicyProvider {
  launcherMeasurement(): string;          // who the launcher is (matches a quote register where measured)
  launcherVersion(): string;
  storagePolicy(): StoragePolicy;         // memEnc, swapOff, ephemeralWritable, noPersistentPlaintext, noPromptLogs
  networkPolicy(): NetworkPolicy;         // allowedEgress[], denyArbitraryEgress, dnsPinned
}

// Binary gate — the launcher's pre-exec check AND the buyer's mirror.
interface BinaryVerifier {
  approve(binary: { digest; version; tag }, registry): BinaryVerdict;  // signed/active/not-revoked
}

// Seller assembly.
interface EvidenceBuilder {
  build(ctx): Promise<EvidenceDocument>;  // §4, signed by the enclave key
}

// Buyer decision.
interface BuyerPolicyVerifier {
  verify(evidence, registry, policy, nonce): VerificationResult;  // the §6 checklist, fail-closed
}
```

`AttestationProvider` (today's seller-side quote source) is the concrete TDX/mock
`PlatformAttestor`; the verifier's existing platform-dispatch (`quote-verifiers.ts`)
is its buyer half. We extend, not replace.

## 4. The evidence document (design requirement I)

Hardware-neutral, enclave-signed. `schema` distinguishes the legacy `antseed-tee/v1`
bundle (quote + report_data + measurements, no runtime layer) from the launcher
schema `antseed-tee/launcher` (the whole design).

```ts
interface EvidenceDocument {
  schema: "antseed-tee/launcher";
  platform: AttestationPlatform;
  claims: ClaimId[];             // the SUBSET of claims this seller attests to (§6)

  // hardware layer
  quote: string;                 // base64 raw vendor quote
  collateral?: Record<string,string>;
  measurements: Record<string,string>;
  reportDataHex: string;

  // bindings (also committed in report_data via the enclave key)
  nonce: string;
  peerPubkey: string;            // secp256k1 channel identity
  enclavePubkey: string;         // ed25519 evidence-signing key (in report_data)

  // channel confidentiality (§5)
  channelPubkey: string;         // X25519 enclave key fingerprint the buyer e2ee's to
  channelKeyAlg: "x25519";

  // runtime / launcher layer
  launcherMeasurement: string;
  launcherVersion: string;
  antseedBinaryDigest: string;
  antseedBinaryVersion: string;
  antseedBinaryTag: string;
  releaseProvenance?: string;    // URL / in-toto ref; signature checked against registry
  storagePolicy: StoragePolicy;  storagePolicyHash: string;
  networkPolicy: NetworkPolicy;  networkPolicyHash: string;
  configHash?: string;
  bundleDigest?: string;
  eventLogRef?: string;          // measured-boot / IMA log reference where applicable

  timestamp: number;
  enclaveSignature: string;      // ed25519(enclavePubkey) over canonical(doc \ {enclaveSignature})
}
```

**Integrity chain:** quote genuine → `report_data` == `packReportData(peer, enclave,
nonce)` → `enclaveSignature` verifies under `enclavePubkey` → every runtime field is
attested. `report_data` is **unchanged** (no wire break; v1 still recomputes).

## 5. Enclave-custodied channel key (design requirement F, relaxed)

Literal TLS termination does not map onto AntSeed's WebRTC/DTLS+TCP transport (the
session terminates *inside the seller process*). The requirement is satisfied
instead by an **enclave-generated, enclave-custodied X25519 key**:

1. The launcher generates the X25519 keypair in-TEE; the private half never leaves
   the process and is never written to disk.
2. Its public fingerprint is in the evidence doc, covered by `enclaveSignature`,
   anchored (via the enclave ed25519 key) to `report_data`.
3. Buyer verifies the quote + doc **first**, then opens an ECDH→AEAD channel to
   `channelPubkey` and sends sensitive payloads only through it.
4. Result: relayed buyer↔seller traffic is e2ee under a key only the in-TEE process
   holds. A relay/MITM without in-TEE memory cannot read it; substitution breaks
   the enclave signature / `report_data`. Extraction by **guest root** is prevented
   **operationally** by the locked runtime (attested via launcher measurement) — and
   where that isn't attested, the buyer fails the confidentiality check (§9).

## 6. Claims — à-la-carte attestation, buyer-decided policy (design requirement E)

**The protocol mandates no fixed attestation set.** A seller attests to ANY subset
of named **claims** (or none). The evidence document lists exactly which claims it
makes (`claims: ClaimId[]`) and carries the evidence for each. The buyer verifies
each claimed property independently and reports, per claim, **{claimed, verdict}**
with verdict ∈ `verified | failed | not-proven`. The buyer's OWN policy declares
`requiredClaims`; routing is allowed iff every required claim is `claimed && verified`.
A buyer with no required claims still receives the full, honest claim report — the
point is **clarity** ("prompts are e2ee", "binary integrity is an official signed
release", …) plus independent verification, not protocol-level coercion.

Named claims (extensible):

| Claim | Plain-language meaning | Verified by |
|-------|------------------------|-------------|
| `hardware-genuine` | runs in a real TEE, debug off, acceptable TCB | silicon quote + collateral |
| `channel-key-bound` | buyer↔seller traffic is e2ee under an enclave-held key | enclave key (in `report_data`) signs the doc binding the channel key |
| `approved-launcher` | the runtime is an approved AntSeed launcher build | launcher measurement ∈ signed set |
| `approved-binary` | the seller binary is an official signed AntSeed release | bound digest ∈ signed binary set (+ release sig) |
| `binary-active` | that release is current, not deprecated/revoked | binary status + revocation |
| `storage-policy` | no persistent plaintext buyer data; writable state ephemeral | measured storage-policy hash ∈ approved + capabilities |
| `network-policy` | egress locked to declared provider/attestation endpoints | measured network-policy hash ∈ approved + capabilities |
| `no-operator-shell` | operator has no shell to read keys/plaintext | launcher capability attested by measurement |
| `mem-encryption` | RAM encrypted by the platform | platform evidence |

**Dependency lattice (keeps à-la-carte sound):** every claim except
`hardware-genuine` is `verified` only if the **binding substrate** holds — quote
genuine + `report_data` binds the served enclave key + nonce + peer + the
`enclaveSignature` over the doc verifies. Otherwise the claimed field is
unsigned/unrooted and the claim is `not-proven`. Registry-backed claims
(`approved-launcher`, `approved-binary`, `binary-active`, policy claims) additionally
require the governance checks (signer pinned, not expired, not rolled back); if the
registry is unusable they are `not-proven`, never silently passed.

So the buyer verdict is NOT "all 15 pass." It is: the substrate is sound, and every
claim the **buyer requires** is present and verified. Everything the seller claims is
shown with its verification status; everything the seller omits is simply absent —
not a failure unless that buyer required it.

## 7. Registry / governance (design requirements B, J)

The signed `ValidSet` gains, alongside today's `entries` (now **launcher/runtime**
entries) and governance fields (`notAfter`, `minVersion`, `revocationEpoch`,
`revokedMeasurements`, signed `auditUrl`):

```ts
interface ValidSetEntry {        // approved launcher/runtime
  platform; measurement;         // launcher/runtime measurement
  launcherVersion?;
  storagePolicyHash?; networkPolicyHash?;  // entry pins the policies it vouches for
  requireTlsBinding?: boolean;             // entry asserts a channel key MUST be bound
  capabilities?: string[];                 // e.g. ["mem-enc","no-operator-shell","egress-locked"]
  status: "active" | "deprecated";
  bundleDigest?; configHash?; tcbPolicy?;
}
interface ApprovedBinary {        // approved AntSeed seller binary
  digest;                         // hash of the seller bundle/binary
  version; tag;                   // semver + channel tag (stable/beta)
  releaseSignature?;              // signature over digest by the release key
  status: "active" | "deprecated";
}
interface ValidSet {
  ...existing...
  binaries?: ApprovedBinary[];
  revokedBinaries?: string[];     // digests revoked regardless of status
}
```

All of it is inside `ValidSetSignedPayload` → none tamperable without breaking the
governance signature. Buyer pins the governance signer (mandatory in production).

## 8. Deployment — AntSeed's image is a REFERENCE, never required (design requirement D)

**Design directive: the image is never a required piece — it is a reference
implementation.** A seller may run ANY confidential-computing image. AntSeed ships a
reference Packer/Terraform image as a convenience — it is one approved measurement,
not a mandate. Compliance is governed entirely by the approved set + capabilities
(see [COMPLIANCE.md](./COMPLIANCE.md)): an image is compliant *for a buyer* iff its
measurement is governance-approved carrying the capabilities that buyer requires.

The launcher unit starts the AntSeed seller binary (verifying its digest first) and
serves launcher evidence. An image *earns* the operational capabilities
(`no-operator-shell`, `egress-locked`, `ephemeral-storage`) by actually enforcing
them per COMPLIANCE.md §2 and being reviewed + signed into the approved set —
whether that image is AntSeed's reference or a third party's, on TDX or any future
platform. An image that does not enforce a capability simply does not carry it; a
buyer requiring it gets `not-proven` and fails closed. There is no central locked
image — the honesty boundary is per measurement, per capability. The path to a fully
gatekeeper-free model is the self-verifying **measured-boot / IMA** track
(COMPLIANCE.md §1), where the buyer checks a measured log directly with no per-image
review.

## 9. What is proven vs not proven (do-not-overclaim)

| Property | Basis | Strength |
|----------|-------|----------|
| genuine TEE, debug off, TCB | silicon-vendor quote + collateral | cryptographic |
| approved launcher ran | quote measurement ∈ signed set | cryptographic |
| approved AntSeed binary ran | enclave-signed doc + signed binary set | cryptographic (binding) |
| channel key is enclave-held | enclave signature + report_data | cryptographic (binding) |
| operator cannot extract key/plaintext | **locked runtime** attested via launcher capability | operational, **attested** |
| storage/network policy enforced | launcher capability + measured policy hash | operational, attested; enforcement is the launcher's, not the silicon's |
| memory encryption | platform evidence (TDX) | cryptographic where the platform reports it |

If a platform cannot establish a row, the verifier emits it under `notProven` or
fails closed under `--require-tee`; it is never reported as verified.

## 10. Backward compatibility (design requirement K)

The buyer understands both `antseed-tee/v1` (old 3 checks) and
`antseed-tee/launcher` (the §6 checklist). `report_data` is unchanged, so existing
v1 quotes/fixtures verify exactly as before. Under `--require-tee` with a launcher
policy, a v1 evidence doc fails the launcher-layer checks (no binary/policy/channel
binding) and is refused — production requires the launcher schema once enabled.
