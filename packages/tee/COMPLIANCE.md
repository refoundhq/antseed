# AntSeed TEE — Image Compliance Spec

**Design directive: the AntSeed image is a REFERENCE implementation, never a
required piece.** A seller may run *any* confidential-computing image it wants. An
image is *compliant* not because AntSeed built it, but because its **measurement is
in the governance-signed approved set with the capabilities it has been verified to
enforce** (`ValidSetEntry.capabilities`). This document is the contract: what an
image must actually enforce to legitimately carry each capability.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the attestation mechanics; this file
is the bridge between a measurement (a hash) and what it *means*.

## 1. The model — compliance is an assertion, not an image

A measurement is just a hash of what booted. It does not, by itself, tell a buyer
that the image denies the operator a shell or locks egress. Someone has to assert
that *about* that measurement. Three trust levels, weakest dependency first:

| Level | Who vouches that measurement X enforces capability C | Status |
|-------|------------------------------------------------------|--------|
| **Governance-asserted** | the pinned governance signer reviewed the image against this spec and signed `{measurement, capabilities}` | **available now** |
| **Self-verifying (measured boot / IMA)** | nobody — the evidence carries a measured boot/IMA log and the buyer applies a policy directly | planned (`eventLogRef`) |
| **Reproducible build** | nobody — anyone rebuilds from published source, reproduces measurement X, and inspects the source | planned |

Image freedom holds at every level: the approved set MAY hold many measurements
from many builders on many platforms. A buyer requires capabilities, not an image.

**You can only assert a property the image actually has.** Signing a capability for
an image that does not enforce it is a false attestation — the reviewer's
responsibility is to confirm enforcement before signing.

## 2. Capability contract

A reviewer signs a capability into an entry ONLY if the image demonstrably enforces
every requirement below. A buyer that requires the capability gets `verified`; one
facing an image whose entry lacks it gets `not-proven` and fails closed.

### `no-operator-shell`
The seller operator (even with cloud-console / root credentials) cannot obtain an
interactive foothold to read broker process memory or the in-enclave keys.
- No `sshd` / remote login service installed or enabled.
- No serial/virtual console getty; no autologin.
- The seller launcher is the controlled entrypoint (PID 1 or a locked unit with
  `NoNewPrivileges`, no shell escape); no general-purpose shell reachable by the
  operator at runtime.
- No debugger / ptrace path to the broker process for the operator.
> This is the capability that backs "operator cannot read the key/plaintext." TDX
> does not provide it — the image does.

### `egress-locked`
Outbound traffic is restricted and the operator cannot widen it post-boot.
- A default-deny egress firewall (nft/iptables) allowing ONLY the declared provider
  endpoint(s) + the required AntSeed/attestation endpoints (`networkPolicy.allowedEgress`).
- DNS pinned (fixed resolver / hosts), not operator-mutable.
- Firewall + resolver config is part of the measured image; not rewritable at
  runtime by the operator.

### `ephemeral-storage`
No buyer plaintext survives, and nothing is paged to disk.
- All writable paths are tmpfs or otherwise ephemeral; nothing persists across reboot.
- Swap disabled (no broker memory paged out).
- No prompt/response or buyer-payload logging to persistent storage.

### `mem-enc`
Platform memory encryption is active. Inherent to genuine TDX / SEV-SNP — the
`hardware-genuine` claim already establishes it; this capability is informational
and a reviewer may set it for platforms where the hardware guarantees it.

### `measured-boot` (forward-looking)
The image emits a measured-boot / IMA event log the buyer can policy-check directly
(the self-verifying level). Reserved; verified once the IMA track lands.

## 2b. Measured specific attestations (Tier A — implemented)

Specific properties a buyer can require **measured into the hardware**, not just
governance-vouched — the "specific attestations, not flat lockdown" model. Each is
an independent à-la-carte claim; the operator may keep a shell, just minus the one
capability that could undo the property.

| Claim | Measured enforcer | Capability dropped | How the buyer verifies |
|-------|-------------------|--------------------|------------------------|
| `egress-allowlisted` | nftables default-deny + allowlist | `CAP_NET_ADMIN` | egress policy's SHA-384 ∈ the RTMR event log AND the log replays to the quote's RTMR3 AND the launcher is approved AND egress meets the buyer's required set |
| `no-buyer-data-at-rest` | tmpfs writable + swap off | `CAP_SYS_ADMIN` | storage policy measured into the RTMR (same chain) |
| `known-binaries-only` | IMA measured execution | — | the IMA log replays to the quote's RTMR AND every measured hash ∈ the signed `knownBinaries` allowlist |

The measured launcher (`antseed-tee-infra/packer/files/antseed-measured-launch`)
applies each enforcer, drops the capability, **extends a TDX RTMR** with the policy
digest (canonical JSON → SHA-384, matching the verifier's `measureDigest`), records
the event log, reads the IMA log, and writes the measured-evidence the seller serves.
The buyer's `verifyLauncherEvidence` replays the log (`rtmr.ts`) against the genuine
quote — a log that doesn't anchor is rejected. This is **Tier A** for these specific
properties without a flat locked image; it depends on the approved launcher honestly
applying what it measures (the `approved-launcher` claim) — its two hardware
validation points (runtime RTMR-extend interface, IMA-into-RTMR) are flagged in the
launcher script and gate enabling it by default.

## 3. Review → sign (governance-asserted, today)

1. A builder publishes their image build (source + the resulting measurement, ideally reproducibly).
2. A governance reviewer confirms the image enforces each claimed capability per §2.
3. The reviewer seeds + signs the measurement with those capabilities:
   ```bash
   antseed tee seed-registry \
     --seller-address <live seller host:port> \   # or --evidence-url
     --key registry-signer.key \
     --capability no-operator-shell --capability egress-locked --capability ephemeral-storage \
     --binary <cli-digest:version:tag> \
     -o tee-validset.json
   ```
4. Buyers pin that governance signer; the entry's capabilities are what they verify
   against `--tee-required-claims`.

The AntSeed reference image is simply a measurement that has been reviewed and
carries the full capability set — a convenience, not a requirement. A self-built
image carrying the same capabilities verifies identically.

## 4. What "compliant" means to a buyer

A seller is compliant **for a given buyer** iff every capability/claim that buyer
requires is `verified`: the hardware quote is genuine, the launcher measurement is
governance-approved, the bound AntSeed binary is approved, and the approved entry
carries the operational capabilities the buyer demands. Different buyers draw the
line in different places (`--tee-required-claims`) — the protocol asserts the
facts; the buyer sets the bar. There is no central "compliant image" gate.
