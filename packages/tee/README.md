# @antseed/tee

Confidential-broker attestation for AntSeed TEE sellers.

A TEE-wrapped seller runs the AntSeed broker inside a CPU confidential VM (Intel
TDX or AMD SEV-SNP), routing inference to **external** provider APIs
(OpenAI / Anthropic). This package provides the **attestation primitive**
(seller side) and the **buyer verifier** + **approved-code registry** (buyer
side) that let a buyer cryptographically check *which code* a seller is running
before trusting it — with **no external platform dependency and no KMS** (trust
roots only on silicon-vendor PKI).

It is an **optional** dependency: non-TEE sellers never install it. It depends on
`@antseed/node` only for *types* (a `peerDependency`); its only runtime
dependency is Node's built-in `node:crypto`.

## MVP scope — requirement #1 only

This MVP proves exactly one property:

> **The seller runs only approved code (any approved version).**

It is built to extend to #2/#3/#4 with no rework. Concretely, the verifier runs
three load-bearing checks:

1. **Quote valid** — genuine TEE, debug-off, TCB-current, nonce-fresh.
   (`mock`: structural validation only; `tdx`: a clearly-marked DCAP integration
   point — the verification *interface* is implemented, the DCAP crypto is a
   `TODO(tee)`.)
2. **`quote.measurement ∈ approvedSet`** — the image measurement (TDX MRTD/RTMR,
   SEV-SNP MEASUREMENT) is in the registry's active approved set.
3. **`quote.reportData == packReportData({ peerPubkey: connectedPeer, nonce })`**
   — the quote is bound to the connected channel and this verification round.

Plus a `notProven` honesty block surfaced verbatim (operator-blind/#2,
no-other-processes/#3, model/#4, v1-not-reproducible, provider-sees-plaintext).

### Measurement vs report_data

These are kept strictly separate:

- The **image measurement** lives in the quote's measurement registers
  (MRTD/RTMR for TDX, MEASUREMENT for SEV-SNP) and is checked against the
  approved set.
- **`report_data`** is the single 64-byte free field the hardware binds. We
  pack it with **one** domain-separated hash:

  ```
  report_data[0:64] = SHA-512( CTX || len|peerPubkey || len|nonce
                                   || len|bundleDigest || len|configHash )
  CTX = "antseed-tee/v1\0"
  ```

  SHA-512 fully consumes the 64 bytes (no padding/slack). For the MVP only
  `peerPubkey` + `nonce` are set; `bundleDigest` / `configHash` are forward-compat
  for requirement #4 and the base/bundle measurement split. `packReportData` is
  **the one canonical encoder** — both the seller (quote generation) and the
  buyer (verifier recompute) route through it.

## Layout

```
src/
  report-data.ts          # THE canonical packReportData + recompute helper
  config.ts               # TeeSellerConfig
  attestation/
    types.ts              # AttestationPlatform, AttestationProvider, AttestationQuote
    mock.ts               # MockAttestation (deterministic, dev/test) + assertProductionPlatform
    tdx.ts                # TdxAttestation (configfs-tsm / tdx_guest sysfs; DCAP TODOs)
    index.ts              # createAttestationProvider(platform?)
  evidence/
    routes.ts             # handleEvidenceRequest: /evidence, /.well-known/..., /pubkey
  registry/
    types.ts              # ValidSet, ValidSetEntry
    client.ts             # RegistryClient — load/verify(ed25519)/cache, fail-closed
  verifier/
    checks.ts             # per-platform quote validation (CHECK 1 backend)
    verify.ts             # verifySeller(...) — numbered tri-state checklist + verdict
  attesting-provider.ts   # v2 TeeAttestingProvider decorator (interface only)
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

## Extension path to #2 / #3 / #4

- **#2 (operator-blind) / #3 (no-other-processes):** these are *image*
  properties certified by the **audit** attached to an approved measurement
  (`ValidSet.auditUrl`). The verifier already proves "an approved measurement is
  running, bound to this channel"; extending to #2/#3 means enriching the
  approved-set audit metadata and (v2) reproducible builds + dm-verity — no
  change to the verifier predicate or `report_data` layout.
- **#4 (advertised model == called model):** implement the `TeeAttestingProvider`
  decorator (already declared as an interface-only stub). It wraps any
  `@antseed/node` `Provider`, signs `{ requestedModel, requestedEffort,
  servedModelEcho }` with the enclave key, and the buyer verifies the signature
  with `peerPubkey`. Because `report_data` already length-prefixes optional
  fields, binding `bundleDigest` / `configHash` requires no layout change.
- **Two-tier (base + bundle):** `ValidSetEntry.bundleDigest` and the optional
  `report_data` fields are already in place; the base becomes the sole quote
  producer and stamps the bundle digest `D` per-quote.
- **SEV-SNP:** add a `SevAttestation` provider (the `'sev-snp'` platform is
  already in the type and a verifier branch is stubbed).
```
