# 07 - Model Verification

**Status:** Proposed / design. None of the mechanisms below are implemented yet.
This document specifies the design space and the recommended architecture so that
implementations (and contributions such as issue #504) target a common model.

## Overview

The reputation layer ([05-reputation.md](./05-reputation.md)) and metering layer
([03-metering.md](./03-metering.md)) answer **whether** a request was served and
**how much** was billed. Neither answers **what** was served.

A Seller can advertise a premium model (e.g. `claude-sonnet-4-6`) on the DHT and
silently serve a cheaper substitute — a different model family, a nano-tier
endpoint, or an aggressively quantized copy of the correct model. The Buyer pays
the advertised price and receives degraded output. Settlement volume,
ghost-channel rate, and ERC-8004 feedback all score the cheating Seller exactly
as well as an honest one, because delivery still happened.

**Model verification** is the set of mechanisms that let a Buyer gain confidence
that the model it paid for is the model it received, and — where the evidence is
strong enough — escalate a confirmed substitution to on-chain slashing.

There is no central verification authority. Every mechanism here is either
Buyer-local or settled through existing peer-to-peer and on-chain primitives.

---

## Threat Model

The adversary is a profit-motivated Seller that:

- Sees every request in plaintext before responding.
- Can run more than one backend and route each request to whichever backend it
  chooses, based on the request content.
- Will serve the advertised model only when it believes it is being watched, and
  the cheap substitute otherwise.

This last capability is the crux. **Any verification signal that is
distinguishable from ordinary Buyer traffic is a defeat device waiting to
happen**: the Seller detects the probe, serves the real model for that request,
and cheats everything else. Distinguishability is the property to design out, not
a detail to tune later.

A secondary adversary is a malicious **Buyer** that fabricates or cherry-picks
evidence to slash an honest Seller. Any mechanism that can trigger an on-chain
penalty MUST be robust against this.

---

## Mechanisms

The mechanisms below are layered. Each is independently useful; combined, they
form an `unattested → signed → attested` trust ladder consistent with the
existing reputation tiers.

### M1 — Behavioral Probes (weakest; bounded usefulness)

The approach proposed in issue #504. The Buyer (or a router middleware) injects
small structured prompts with deterministic, automatically scorable answers —
exact integer counts, fixed-schema JSON, multi-step arithmetic, fixed-length
output — and scores the response with a pure matcher function. An aggregate score
below a threshold over a session yields a fail verdict.

**Strengths:** zero Seller-side changes; cheap (≤30 output tokens per probe);
honest Sellers pass automatically; catches the lazy/casual substitution case.

**Limitations (MUST be understood before relying on this):**

- **Distinguishability.** Probes drawn from a fixed bank, sent as side-channel
  requests that bypass normal routing, are detectable by the adversary in the
  threat model above. A static probe bank published in this repository ossifies
  the moment it is public.
- **Tier, not identity.** Capability probes (arithmetic, format compliance)
  separate a nano tier from a frontier tier. They do **not** distinguish two
  models of similar capability (e.g. a 70B open model impersonating Sonnet), and
  they do **not** detect quantization of the correct model.
- **Self-reported identity is not a signal.** "Who made you?" probes are trivially
  defeated by a one-line system prompt, and open models routinely misreport their
  creator due to training contamination. This probe class SHOULD NOT be used.

M1 is acceptable as a cheap first-pass deterrent and as a way to prioritize where
to spend the more expensive mechanisms. It MUST NOT, on its own, drive on-chain
penalties.

### M2 — Reference Shadow Sampling (recommended core mechanism)

Instead of synthetic probes, sample **real** Buyer traffic. Because the probe is
an actual user request, the Seller cannot treat it differently without treating
all traffic the same way — distinguishability is eliminated by construction.

On a small random fraction `p` of real requests (default `p = 0.02`):

1. The Buyer sends the request to the selected Seller as normal.
2. The Buyer also sends the identical request to a **reference** for the same
   advertised model: the canonical upstream API (when the Buyer holds a key) or a
   TEE-attested peer (see M5) serving that model.
3. The Buyer stores both responses locally, keyed by the request.

A single (request, response) pair proves nothing: at any temperature, serving
stacks are not bitwise deterministic (batching, MoE routing, kernel differences).
Verification is therefore **distributional and accumulated**, never per-request:

- The Buyer accumulates `N` sampled triples for a given Seller (default `N ≥ 30`).
- It runs a two-sample statistical test comparing the Seller's output
  distribution against the reference's (e.g. a Model-Equality-style test over
  per-request similarity, or a distance over output-length / token-distribution
  features). This detects both family substitution and quantization in aggregate.
- Pass → samples are discarded; nothing is published. Fail → the Seller is
  flagged.

**Cost:** `2×` tokens on the sampled fraction only — i.e. ~`p` overhead on total
spend. Probe spend flows through the normal payment channel and SHOULD be tagged
in metering so it is distinguishable from organic usage for accounting.

### M3 — Signed Responses (non-repudiation; enables disputes)

M1 and M2 let a Buyer adjust its **own** routing. They do not, by themselves,
support a verdict any third party can trust, because an unsigned response is
hearsay: the Seller can claim the Buyer fabricated it.

To make verdicts portable, the Seller signs every response:

```
responseAuth = sign_secp256k1( DOMAIN_TAG || keccak256(requestBytes) || keccak256(responseBytes) )
```

- Signature format per [00-conventions.md](./00-conventions.md): 130-hex
  secp256k1 (EIP-191), recovered to the Seller's PeerId (its EVM address).
- The signature is attached to the per-request receipt (see
  [03-metering.md](./03-metering.md)), **not** requested per-response. Requesting
  a signature on specific responses would itself be a distinguishable probe (M1's
  flaw); the Seller signs unconditionally so it cannot know which responses will
  later be scrutinized.
- The signature binds *who emitted which bytes for which request*. It carries no
  quality claim on its own — quality comes from M2's statistics.

The hash is a binding commitment, not a privacy mechanism: the Buyer retains full
plaintext. Hashing only avoids signing megabytes and lets a third party recompute
and verify cheaply.

A Seller MAY decline to sign. Unsigned Sellers simply occupy a lower trust tier:
no dispute can be escalated against them, and Buyers price that in. "Signs every
response" is therefore an advertised capability, not a protocol-wide requirement.

### M4 — Passive Fingerprinting (free; always on; triage only)

From ordinary traffic the Buyer derives per-Seller statistics that need no extra
requests: inter-token latency distribution, time-to-first-token, output-length
distribution, and stop/refusal patterns. Each Seller is compared against the
cohort of Sellers advertising the same model; outliers are flagged.

This is weak on its own (timing is noisy and environment-dependent) and MUST NOT
drive penalties. Its value is **triage**: it is zero-cost and tells the Buyer
where to spend M2 sampling budget instead of sampling uniformly.

### M5 — TEE Attestation (strongest; premium tier)

An attested Seller proves, via a hardware remote-attestation quote, which
endpoint and weights it serves. Attested Sellers:

- Require no statistical inference — the attestation is the proof.
- Double as the trusted **reference** for M2, which bootstraps verification for
  Buyers that do not hold canonical upstream API keys.

Attestation is the top of the trust ladder and is expected to command a price
premium. It is out of scope for v1 beyond reserving the tier.

---

## Verification Flow

The end-to-end flow combines the mechanisms. Note what is continuous, what is
sampled, and what is rare:

**Every request (100%):**

1. Buyer → Seller request; Seller → response with `responseAuth` (M3).
2. Buyer verifies `responseAuth` recovers to the Seller's PeerId and proceeds.
3. Buyer updates passive fingerprint statistics (M4).

**Sampled request (`p`, Seller cannot tell which):**

4. Buyer additionally queries the reference and stores both signed responses
   locally (M2).

**Accumulation (per Seller, ongoing, Buyer-local):**

5. Once `N` samples exist, Buyer runs the distributional test (M2). Pass →
   discard. Fail → flag the Seller.

**Local enforcement (immediate, no consensus needed):**

6. A flagged Seller is dropped from this Buyer's `selectPeer()` candidate pool.
   This is the Buyer's own routing choice and requires no external agreement.

**Escalation (rare; only on a flagged, signed Seller):**

7. If the Buyer seeks on-chain consequences, it assembles an **evidence exhibit**:
   the signed sample set plus the corresponding reference responses.
8. The exhibit is submitted to a dispute path. Raw request/response bytes leave
   the Buyer **only at this step** and go to the arbiter, not to any public feed.
   On-chain, only a commitment (a hash of the exhibit) need be stored; the bytes
   may live off-chain and be revealed during adjudication.
9. The arbiter does not trust the Buyer. It (a) verifies every `responseAuth`
   mechanically — proving the samples are genuinely the Seller's — and (b)
   re-runs the test, or better, re-queries the accused Seller and the reference
   itself with fresh requests, since a real substitution reproduces over fresh
   samples while a fabricated accusation does not. On confirmation, the swappable
   slashing contract (`AntseedSlashing`) burns the Seller's stake.

---

## Privacy

Verification MUST NOT broadcast Buyer traffic. Real prompts and completions are
sensitive. Accordingly:

- M2 samples are stored Buyer-locally and discarded on a pass.
- Raw bytes leave the Buyer only inside a dispute exhibit, addressed to an
  arbiter, and only for a Seller already flagged.
- On-chain artifacts are commitments (hashes), never plaintext.

---

## Abuse Resistance (malicious Buyer)

Signed responses (M3) make the Seller non-repudiable, which neutralizes the
naive forge-evidence attack: a Buyer cannot invent a signed response. The
residual attack is **selective omission** — a Buyer presenting only unfavorable
samples. This is countered by requiring the exhibit's sample set to reconcile
against the Buyer's metered request history (already retained for billing per
[03-metering.md](./03-metering.md)) and by the arbiter's own fresh re-query in
step 9, which does not depend on the Buyer's samples at all.

---

## Parameters

| Parameter | Symbol | Default | Notes |
|---|---|---|---|
| Sample rate | `p` | 0.02 | Fraction of real requests duplicated to reference (M2) |
| Min samples per verdict | `N` | 30 | Below this, no M2 verdict is emitted |
| Distributional fail threshold | — | tuned on real traffic | Drives *local* flagging only |
| Probe cadence (if M1 used) | — | 1 / 20 requests | M1 is deterrence/triage only |

Thresholds that affect **local** routing may be liberal. Thresholds that gate
**on-chain** penalties MUST be conservative and are ultimately the arbiter's
decision in step 9, not a Buyer-side constant.

---

## Relationship to Other Layers

- **Reputation ([05](./05-reputation.md)):** a confirmed substitution is the kind
  of signal the future ERC-8004 `Accuracy` path could carry — but only after
  arbiter confirmation (step 9), never directly from an M1/M2 fail verdict.
- **Metering ([03](./03-metering.md)):** carries `responseAuth` (M3) and the
  retained request history used for abuse resistance.
- **Security ([06](./06-security-overview.md)):** model substitution is a
  trust-boundary violation between Buyer and Seller; this document is the
  cross-reference for that residual risk.

---

## Summary

| Mechanism | Cost | Detects | Drives penalties? |
|---|---|---|---|
| M1 Behavioral probes | very low | tier mismatch, lazy substitution | No (deterrence/triage) |
| M2 Reference shadow sampling | ~`p` of spend | family substitution, quantization | Local routing; on-chain only via M3 exhibit |
| M3 Signed responses | negligible | nothing alone — enables M2 evidence | Yes, as exhibit input |
| M4 Passive fingerprinting | free | gross outliers | No (triage) |
| M5 TEE attestation | premium | proves served endpoint/weights | Authoritative |

The recommended v1 is **M2 + M3 + M4**: sample real traffic against a reference,
sign responses so verdicts are portable, and use passive statistics to aim the
sampling budget. M1 is an optional cheap deterrent; M5 is the premium tier.
