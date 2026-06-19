import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import type { AttestationPlatform } from "../attestation/types.js";
import type { RtmrEvent, ImaEntry } from "./rtmr.js";

/**
 * The launcher evidence document + its enclave-signature primitive.
 *
 * The hardware quote's 64-byte `report_data` binds only the enclave ed25519 key +
 * peer + nonce (see report-data.ts). That enclave key then SIGNS this document, so
 * every runtime/launcher field below inherits hardware-rooted integrity without
 * enlarging report_data — and v1 verifiers keep working because report_data is
 * unchanged. This is the backbone of the design (see ARCHITECTURE.md §4).
 */

export const EVIDENCE_SCHEMA_LAUNCHER = "antseed-tee/launcher" as const;
export const EVIDENCE_SCHEMA_V1 = "antseed-tee/v1" as const;

/**
 * The à-la-carte claim vocabulary. A seller attests to ANY subset; the buyer
 * verifies each independently and reports {claimed, verdict} (ARCHITECTURE.md §6).
 */
export type ClaimId =
  | "hardware-genuine"
  | "channel-key-bound"
  | "approved-launcher"
  | "approved-binary"
  | "binary-active"
  | "storage-policy"
  | "network-policy"
  | "no-operator-shell"
  | "mem-encryption"
  // --- MEASURED specific attestations (RTMR-anchored; Tier A — see COMPLIANCE.md) ---
  | "egress-allowlisted"
  | "no-buyer-data-at-rest"
  | "known-binaries-only";

export const ALL_CLAIMS: readonly ClaimId[] = [
  "hardware-genuine",
  "channel-key-bound",
  "approved-launcher",
  "approved-binary",
  "binary-active",
  "storage-policy",
  "network-policy",
  "no-operator-shell",
  "mem-encryption",
  "egress-allowlisted",
  "no-buyer-data-at-rest",
  "known-binaries-only",
];

/**
 * Canonical operational capability identifiers a governance-signed approved entry
 * MAY assert about a measurement (`ValidSetEntry.capabilities`). The mapping from
 * each id to the image properties it requires is the contract in COMPLIANCE.md §2.
 * The list is OPEN — a buyer may require any capability string and a reviewer may
 * sign a new one; this is the documented reference set, not a closed enum.
 */
export const KNOWN_CAPABILITIES = [
  "no-operator-shell",
  "egress-locked",
  "ephemeral-storage",
  "mem-enc",
  "measured-boot",
] as const;
export type KnownCapability = (typeof KNOWN_CAPABILITIES)[number];

/** Runtime storage posture the launcher attests (and a buyer can require). */
export interface StoragePolicy {
  /** Platform memory encryption is present (TDX/SEV memory confidentiality). */
  memoryEncrypted: boolean;
  /** Swap is disabled (no broker memory paged to disk). */
  swapDisabled: boolean;
  /** Writable paths are tmpfs / otherwise ephemeral (nothing survives a reboot). */
  ephemeralWritable: boolean;
  /** No persistent plaintext buyer payloads are written to disk. */
  noPersistentPlaintext: boolean;
  /** Logs do not persist prompts/responses. */
  noPromptLogs: boolean;
}

/** Runtime network posture the launcher attests (and a buyer can require). */
export interface NetworkPolicy {
  /** Allowed egress endpoints (provider APIs + AntSeed/attestation endpoints). */
  allowedEgress: string[];
  /** Arbitrary/other egress is denied by the launcher/runtime. */
  denyArbitraryEgress: boolean;
  /** DNS/proxy is pinned and cannot be changed by the operator after launch. */
  dnsPinned: boolean;
}

/**
 * The hardware-neutral evidence document. Optional fields are present iff the
 * seller attests the corresponding claim (`claims`). `enclaveSignature` covers the
 * canonical document MINUS itself, under `enclavePubkey`.
 */
export interface EvidenceDocument {
  schema: typeof EVIDENCE_SCHEMA_LAUNCHER;
  /** The subset of claims this seller attests to. */
  claims: ClaimId[];
  platform: AttestationPlatform;

  // hardware layer
  quote: string; // base64 raw vendor quote
  collateral?: Record<string, string>;
  measurements: Record<string, string>;
  reportDataHex: string;

  // bindings (also committed in report_data via the enclave key)
  nonce: string;
  peerPubkey: string; // secp256k1 channel identity
  enclavePubkey: string; // ed25519 evidence-signing key (SPKI-DER hex), in report_data

  // channel confidentiality (claim: channel-key-bound)
  channelPubkey?: string; // X25519 enclave key the buyer e2ee's to
  channelKeyAlg?: "x25519";

  // runtime / launcher layer
  launcherMeasurement?: string;
  launcherVersion?: string;
  antseedBinaryDigest?: string;
  antseedBinaryVersion?: string;
  antseedBinaryTag?: string;
  releaseProvenance?: string;
  storagePolicy?: StoragePolicy;
  storagePolicyHash?: string;
  networkPolicy?: NetworkPolicy;
  networkPolicyHash?: string;
  configHash?: string;
  bundleDigest?: string;
  eventLogRef?: string;

  // --- measured runtime policy (RTMR-anchored; Tier A) ---
  /** Ordered measured-event log the launcher extended into the runtime RTMR(s). */
  rtmrLog?: RtmrEvent[];
  /** IMA measurement log (executables/files measured before they ran). */
  imaLog?: ImaEntry[];
  /** Which RTMR the IMA log extends (default 2). */
  imaRtmrIndex?: number;

  timestamp: number;
  enclaveSignature: string; // ed25519(enclavePubkey) over canonical(doc \ enclaveSignature)
}

/** Stable, key-sorted JSON with undefined fields omitted — signer and verifier hash identical bytes. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(",")}}`;
}

/** Canonical sha256 hex of a policy object (storage or network). */
export function hashPolicy(policy: StoragePolicy | NetworkPolicy): string {
  return createHash("sha256").update(stableStringify(policy)).digest("hex");
}

/** Canonical bytes the enclave signature covers: the document WITHOUT `enclaveSignature`. */
export function canonicalizeEvidenceDocument(doc: EvidenceDocument): Uint8Array {
  const { enclaveSignature: _omit, ...rest } = doc;
  return new TextEncoder().encode(stableStringify(rest));
}

/**
 * Sign an evidence document with the in-enclave ed25519 private key. Accepts a
 * KeyObject or a PKCS#8 PEM. Returns the hex signature to place in
 * `enclaveSignature`.
 */
export function signEvidenceDocument(
  doc: Omit<EvidenceDocument, "enclaveSignature">,
  enclavePrivateKey: KeyObject | string,
): string {
  const key =
    typeof enclavePrivateKey === "string"
      ? createPrivateKey({ key: enclavePrivateKey, format: "pem", type: "pkcs8" })
      : enclavePrivateKey;
  const message = canonicalizeEvidenceDocument({ ...doc, enclaveSignature: "" } as EvidenceDocument);
  return cryptoSign(null, Buffer.from(message), key).toString("hex");
}

/**
 * Verify the enclave signature over the document, under the SPKI-DER-hex
 * `enclavePubkey` carried in the doc itself. The caller must SEPARATELY confirm
 * (via report_data) that this `enclavePubkey` is the hardware-bound key — otherwise
 * an attacker could sign with their own key. Returns false on any error.
 */
export function verifyEvidenceSignature(doc: EvidenceDocument): boolean {
  if (!doc.enclavePubkey || !doc.enclaveSignature) return false;
  try {
    const pub = createPublicKey({
      key: Buffer.from(doc.enclavePubkey, "hex"),
      format: "der",
      type: "spki",
    });
    return cryptoVerify(
      null,
      Buffer.from(canonicalizeEvidenceDocument(doc)),
      pub,
      Buffer.from(doc.enclaveSignature, "hex"),
    );
  } catch {
    return false;
  }
}
