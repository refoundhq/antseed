# @antseed/tee

Confidential-broker attestation for AntSeed TEE sellers.

A TEE-wrapped seller runs the AntSeed broker inside a CPU confidential VM (Intel
TDX today), routing inference to **external** provider APIs. This package provides
the **seller-side attestation primitive** and the **buyer-side verifier +
governance registry** that let a buyer cryptographically check *what a seller is
running* before trusting it — with **no external platform dependency and no KMS**
(trust roots only on silicon-vendor PKI). Its only runtime dependency is Node's
built-in `node:crypto`; `@antseed/node` is a types-only `peerDependency`. Non-TEE
sellers never install it.

The full design contract is **[`ARCHITECTURE.md`](./ARCHITECTURE.md)**; the
capability→image-property compliance contract is
**[`COMPLIANCE.md`](./COMPLIANCE.md)**.

## The model: à-la-carte claims, buyer-decided policy

The protocol mandates **no fixed attestation set**. A seller attests to ANY subset
of named **claims**; the evidence document lists them; the buyer verifies each
independently and reports per-claim `{claimed, verdict}` (`verified` / `failed` /
`not-proven` / `not-claimed`), then applies its OWN `requiredClaims` policy and
fails closed on anything unmet.

Soundness comes from a **dependency lattice**: every runtime claim is `verified`
only if the binding **substrate** holds — the quote is genuine, `report_data`
binds the served enclave key + peer + nonce, and the in-enclave ed25519 key signs
the evidence document. The enclave-signs-the-document move carries unbounded
attested fields **without** enlarging `report_data`, so v1 verifiers keep working.

The protocol claim set is **sealed** (`verifier/claims.ts`): the built-in
evaluators register at load, then the registry is closed — a claim can only be
added by an attested `@antseed/tee` release, never runtime injection or override. A
seller-attested claim the protocol doesn't know has no evaluator → `not-proven` →
fail-closed.

| Claim | Verified when … |
| --- | --- |
| `hardware-genuine` | genuine TEE quote, debug off, TCB acceptable, nonce-fresh |
| `channel-key-bound` | an enclave-held X25519 key is attested (advertised — payload e2ee to it is **not yet wired**, see ARCHITECTURE §5) |
| `approved-launcher` | the launcher measurement ∈ the governance-signed approved set |
| `approved-binary` | the bound binary digest is an approved release — **only under** `approved-launcher` (the digest is self-reported) |
| `binary-active` | that release is active (not deprecated/revoked) |
| `storage-policy` / `network-policy` | the policy hash is vouched by the approved launcher entry (governance-asserted) |
| `no-operator-shell` / `mem-encryption` | capability vouched / platform memory encryption present |
| `no-buyer-data-at-rest` / `egress-allowlisted` / `known-binaries-only` | **measured** (Tier A): the policy digest is in the launcher's RTMR event-log AND the log replays to the genuine quote's RTMR |

`verifier/claims.ts` also exports `CLAIM_INFO` / `claimInfo(id)` — a buyer-facing
`{ label, blurb }` per claim for UIs and the CLI report.

## Layout

```
src/
  report-data.ts            THE canonical report_data encoder (seller + buyer route through it)
  config.ts                 TeeSellerConfig
  attestation/              SELLER quote generation
    types.ts                AttestationPlatform / Provider / Quote
    mock.ts                 deterministic dev/test provider
    tdx.ts                  TdxAttestation — configfs-tsm / tdx_guest; parses MRTD + RTMR0-3
    collateral.ts           DCAP collateral fetch/embed
  evidence/                 the launcher evidence document
    document.ts             EvidenceDocument (schema antseed-tee/launcher) + enclave sign/verify + ClaimId + policies
    rtmr.ts                 measured-event log: rtmrExtend/replayRtmr/measureDigest (SHA-384) + IMA helpers
    builder.ts              buildLauncherEvidence — seller assembly + enclave-sign
    serving.ts              createLauncherEvidenceHandler — hardened evidence serving
    routes.ts               v1 evidence routes (/evidence, /.well-known/…, /pubkey)
  registry/                 governance-signed approved set
    types.ts                ValidSet / ValidSetEntry / ApprovedBinary (all signed)
    client.ts               RegistryClient — load/verify(ed25519)/cache, fail-closed
    binary.ts               BinaryVerifier (shared by launcher gate + buyer) + release-sig
    sign.ts                 gen/sign registry keys
  verifier/                 BUYER verification
    quote-verifiers.ts      QUOTE_VERIFIERS registry (tdx=real DCAP, sev-snp=fail-closed, mock)
    dcap.ts                 real Intel DCAP quote verification (@phala/dcap-qvl)
    policy.ts               VerificationPolicy (requiredClaims/storage/network/binary pins)
    launcher-verify.ts      verifyLauncherEvidence — the à-la-carte claims verifier
    claims.ts               SEALED claim-evaluator registry + CLAIM_INFO labels
    checks.ts / verify.ts   v1 (antseed-tee/v1) quote checklist — kept for back-compat
  attesting-provider.ts     TeeAttestingProvider (model-verify decorator; interface)
```

Exports split seller-side (`./attestation`, `./evidence`) from buyer-side
(`./verifier`, `./registry`).

## Install & test

```bash
cd packages/tee
pnpm install
pnpm run typecheck   # tsc --noEmit (strict, NodeNext)
pnpm test            # vitest run
```
