import { resolveTxt } from "node:dns/promises";

import type { DomainVerificationClaim, DomainVerificationMethod, PeerMetadata } from "./peer-metadata.js";

export const DOMAIN_VERIFICATION_TXT_PREFIX = "antseed-peer=";
export const DOMAIN_VERIFICATION_TXT_NAME_PREFIX = "_antseed.";
export const DOMAIN_VERIFICATION_WELL_KNOWN_PATH = "/.well-known/antseed.json";
export const DOMAIN_VERIFICATION_WELL_KNOWN_TYPE = "antseed-domain-verification";

export interface DomainVerificationAttemptResult {
  method: DomainVerificationMethod;
  verified: boolean;
  error?: string;
}

export interface DomainVerificationResult {
  domain: string;
  peerId: string;
  verified: boolean;
  method?: DomainVerificationMethod;
  checkedAtMs: number;
  attempts: DomainVerificationAttemptResult[];
}

export interface DomainVerificationOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  resolveTxt?: (hostname: string) => Promise<string[][]>;
}

interface WellKnownDomainProof {
  type?: unknown;
  peerId?: unknown;
  domain?: unknown;
}

const ALL_DOMAIN_VERIFICATION_METHODS: DomainVerificationMethod[] = ["dns-txt", "https-well-known"];

function normalizePeerId(peerId: string): string {
  return peerId.trim().toLowerCase().replace(/^0x/, "");
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

function normalizeMethods(claim: DomainVerificationClaim): DomainVerificationMethod[] {
  const methods = claim.methods && claim.methods.length > 0
    ? claim.methods
    : ALL_DOMAIN_VERIFICATION_METHODS;
  return ALL_DOMAIN_VERIFICATION_METHODS.filter((method) => methods.includes(method));
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function withTimeoutSignal(signal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("domain verification timed out")), timeoutMs);
  if (!signal) {
    return {
      signal: controller.signal,
      cleanup: () => clearTimeout(timer),
    };
  }
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    },
  };
}

function txtRecordMatchesPeerId(record: string, peerId: string): boolean {
  return record
    .split(/\s+/)
    .some((part) => {
      const [key, value] = part.split("=", 2);
      return key === DOMAIN_VERIFICATION_TXT_PREFIX.slice(0, -1) && normalizePeerId(value ?? "") === peerId;
    });
}

async function verifyDnsTxt(
  domain: string,
  peerId: string,
  resolver: (hostname: string) => Promise<string[][]>,
): Promise<DomainVerificationAttemptResult> {
  const hostname = `${DOMAIN_VERIFICATION_TXT_NAME_PREFIX}${domain}`;
  try {
    const records = await resolver(hostname);
    const verified = records
      .map((chunks) => chunks.join(""))
      .some((record) => txtRecordMatchesPeerId(record, peerId));
    return verified
      ? { method: "dns-txt", verified: true }
      : { method: "dns-txt", verified: false, error: `No TXT record matched ${DOMAIN_VERIFICATION_TXT_PREFIX}${peerId}` };
  } catch (err) {
    return { method: "dns-txt", verified: false, error: formatError(err) };
  }
}

async function verifyWellKnown(
  domain: string,
  peerId: string,
  options: Required<Pick<DomainVerificationOptions, "fetch">> & Pick<DomainVerificationOptions, "signal" | "timeoutMs">,
): Promise<DomainVerificationAttemptResult> {
  const timeoutMs = options.timeoutMs ?? 3_000;
  const { signal, cleanup } = withTimeoutSignal(options.signal, timeoutMs);
  try {
    const response = await options.fetch(`https://${domain}${DOMAIN_VERIFICATION_WELL_KNOWN_PATH}`, {
      headers: { accept: "application/json" },
      signal,
    });
    if (!response.ok) {
      return { method: "https-well-known", verified: false, error: `HTTP ${response.status}` };
    }
    const proof = await response.json() as WellKnownDomainProof;
    const proofPeerId = typeof proof.peerId === "string" ? normalizePeerId(proof.peerId) : "";
    const proofDomain = typeof proof.domain === "string" ? normalizeDomain(proof.domain) : domain;
    if (proof.type !== DOMAIN_VERIFICATION_WELL_KNOWN_TYPE) {
      return { method: "https-well-known", verified: false, error: "Proof type mismatch" };
    }
    if (proofPeerId !== peerId) {
      return { method: "https-well-known", verified: false, error: "Proof peerId mismatch" };
    }
    if (proofDomain !== domain) {
      return { method: "https-well-known", verified: false, error: "Proof domain mismatch" };
    }
    return { method: "https-well-known", verified: true };
  } catch (err) {
    return { method: "https-well-known", verified: false, error: formatError(err) };
  } finally {
    cleanup();
  }
}

export function buildDomainVerificationTxtValue(peerId: string): string {
  return `${DOMAIN_VERIFICATION_TXT_PREFIX}${normalizePeerId(peerId)}`;
}

export function buildDomainVerificationWellKnownProof(peerId: string, domain: string): {
  type: typeof DOMAIN_VERIFICATION_WELL_KNOWN_TYPE;
  peerId: string;
  domain: string;
} {
  return {
    type: DOMAIN_VERIFICATION_WELL_KNOWN_TYPE,
    peerId: normalizePeerId(peerId),
    domain: normalizeDomain(domain),
  };
}

export async function verifyDomainVerificationClaim(
  claim: DomainVerificationClaim,
  peerId: string,
  options?: DomainVerificationOptions,
): Promise<DomainVerificationResult> {
  const normalizedPeerId = normalizePeerId(peerId);
  const normalizedDomain = normalizeDomain(claim.domain);
  const methods = normalizeMethods(claim);
  const attempts = await Promise.all(methods.map((method) => {
    if (method === "dns-txt") {
      return verifyDnsTxt(normalizedDomain, normalizedPeerId, options?.resolveTxt ?? resolveTxt);
    }
    return verifyWellKnown(normalizedDomain, normalizedPeerId, {
      fetch: options?.fetch ?? fetch,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    });
  }));
  const success = attempts.find((attempt) => attempt.verified);
  return {
    domain: normalizedDomain,
    peerId: normalizedPeerId,
    verified: success !== undefined,
    ...(success ? { method: success.method } : {}),
    checkedAtMs: Date.now(),
    attempts,
  };
}

export async function verifyPeerMetadataDomains(
  metadata: PeerMetadata,
  options?: DomainVerificationOptions,
): Promise<DomainVerificationResult[]> {
  const claims = metadata.verifications?.domains ?? [];
  return Promise.all(
    claims.map((claim) => verifyDomainVerificationClaim(claim, metadata.peerId, options)),
  );
}
