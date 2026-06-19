import type { EvidenceDocument, ClaimId } from "../evidence/document.js";
import type { VerificationPolicy } from "./policy.js";
import type { RegistryClient } from "../registry/client.js";
import type { ValidSet, ValidSetEntry } from "../registry/types.js";
import type { QuoteGenuineness } from "./quote-verifiers.js";

/**
 * Pluggable claim model. The à-la-carte claims are evaluated through a REGISTRY of
 * `ClaimEvaluator`s rather than a hardcoded list, so a new AntSeed version (or a
 * third party) can add a claim by registering an evaluator + a buyer-facing label —
 * the core verify loop (`verifyLauncherEvidence`) is unchanged. `ClaimId` is an open
 * string union so custom claim ids are permitted while the known ones autocomplete.
 */

export type ClaimVerdict = "verified" | "failed" | "not-proven" | "not-claimed";

export interface ClaimResult {
  claim: ClaimId;
  /** Did the seller attest this claim? */
  claimed: boolean;
  verdict: ClaimVerdict;
  detail: string;
}

/** Everything a claim evaluator may need — computed once per verification. */
export interface ClaimContext {
  doc: EvidenceDocument;
  policy: VerificationPolicy;
  registry: RegistryClient;
  /** The verified ValidSet (`registry.getValidSet()`), or undefined. */
  set: ValidSet | undefined;
  /** The active approved entry for the launcher measurement, or undefined. */
  entry: ValidSetEntry | undefined;
  /** The quote-genuineness result (platform-dispatched). */
  g: QuoteGenuineness;
  /** Canonical launcher measurement from the quote. */
  measurement: string;
  isMock: boolean;
  /** Trust substrate: quote genuine + report_data binds peer+enclave+nonce + enclave signature valid. */
  docOk: boolean;
  bindingOk: boolean;
  hardwareReal: boolean;
}

export type ClaimEvaluator = (ctx: ClaimContext) => ClaimResult;

const REGISTRY = new Map<string, ClaimEvaluator>();
let sealed = false;

/**
 * Register a claim evaluator. INTERNAL + protocol-only: the built-in claims register
 * at module load, then {@link sealClaimRegistry} is called and no further (or
 * overriding) registration is possible — a runtime call throws. Claims are therefore
 * fixed by the `@antseed/tee` protocol VERSION (itself attested via approved-binary /
 * known-binaries-only); adding a claim is a protocol-attested upgrade (a new release),
 * never runtime injection. NOT re-exported from the package's public surface.
 */
export function registerClaimEvaluator(claim: string, evaluator: ClaimEvaluator): void {
  if (sealed) {
    throw new Error(
      `claim registry is SEALED: "${claim}" cannot be added/overridden at runtime. ` +
        `Claims are fixed by the @antseed/tee protocol version — add one via a protocol ` +
        `upgrade (a new, attested release), not runtime registration.`,
    );
  }
  if (REGISTRY.has(claim)) {
    throw new Error(`claim "${claim}" is already registered (no overrides)`);
  }
  REGISTRY.set(claim, evaluator);
}

/** Seal the registry after the built-in protocol claims register. Idempotent. */
export function sealClaimRegistry(): void {
  sealed = true;
}

/** True once the protocol claim set is sealed. */
export function isClaimRegistrySealed(): boolean {
  return sealed;
}

/** The registered (sealed) protocol claims, in registration order (the report order). */
export function claimEvaluators(): ReadonlyMap<string, ClaimEvaluator> {
  return REGISTRY;
}

// ---- user-facing labels (buyer UI / report) ----

export interface ClaimInfo {
  /** Short plain-English title. */
  label: string;
  /** One-line buyer-facing description of what the claim means. */
  blurb: string;
}

export const CLAIM_INFO: Readonly<Record<string, ClaimInfo>> = Object.freeze({
  "hardware-genuine": {
    label: "Genuine secure enclave",
    blurb: "Runs in a real hardware TEE — debug off, trusted-computing-base up to date.",
  },
  "channel-key-bound": {
    label: "Enclave-held channel key",
    blurb: "The key securing your connection is generated and held inside the enclave.",
  },
  "approved-launcher": {
    label: "Approved runtime",
    blurb: "The runtime measurement matches an AntSeed-approved launcher.",
  },
  "approved-binary": {
    label: "Official signed binary",
    blurb: "The seller runs an official, signed AntSeed release.",
  },
  "binary-active": {
    label: "Current release",
    blurb: "That release is current — not deprecated or revoked.",
  },
  "storage-policy": {
    label: "Storage policy (vouched)",
    blurb: "No persistent plaintext; writable state is ephemeral (governance-vouched).",
  },
  "network-policy": {
    label: "Network policy (vouched)",
    blurb: "Egress is restricted to declared endpoints (governance-vouched).",
  },
  "no-operator-shell": {
    label: "No operator shell",
    blurb: "The operator has no shell to read your keys or plaintext.",
  },
  "mem-encryption": {
    label: "Encrypted memory",
    blurb: "Guest memory is encrypted by the hardware platform.",
  },
  "egress-allowlisted": {
    label: "Locked egress (measured)",
    blurb: "Your query can only be sent to the declared allowlist — measured into the hardware.",
  },
  "no-buyer-data-at-rest": {
    label: "Never written to disk (measured)",
    blurb: "Your query is never written to persistent storage — measured into the hardware.",
  },
  "known-binaries-only": {
    label: "Only approved binaries run (measured)",
    blurb: "Only approved binaries have executed — anchored to the hardware measurement log.",
  },
});

/** Plain-English info for a claim id; falls back to the raw id for custom claims. */
export function claimInfo(id: ClaimId): ClaimInfo {
  return CLAIM_INFO[id] ?? { label: String(id), blurb: "" };
}
