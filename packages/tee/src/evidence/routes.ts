import type { AttestationProvider, AttestationQuote } from "../attestation/types.js";

/**
 * Context the seller wires into the evidence handler. The seller half reuses the
 * existing signaling-port HTTP server — these routes are pure functions of the
 * request URL plus this context, so they can be registered as an extension on
 * the connection-manager GET dispatcher without a new port/listener.
 */
export interface EvidenceContext {
  /** The attestation provider that issues quotes (tdx / mock). */
  attestation: AttestationProvider;
  /** Hex secp256k1 AntSeed peer public key (authenticates the P2P channel). */
  peerPubkey: string;
  /** Hex ed25519 in-enclave evidence-signing public key (served at /pubkey, bound into report_data). */
  enclavePubkey: string;
  /** Optional bundle digest D to bind (forward-compat; omitted in MVP). */
  bundleDigest?: string;
  /** Optional effective-config hash to bind (forward-compat; omitted in MVP). */
  configHash?: string;
}

/** The discovery descriptor served at /.well-known/antseed-evidence. */
export interface EvidenceDescriptor {
  scheme: "antseed-tee/v1";
  platform: string;
  evidencePath: string;
  pubkeyPath: string;
}

/** A fresh evidence bundle whose quote binds the buyer's nonce. */
export interface EvidenceBundle {
  scheme: "antseed-tee/v1";
  platform: string;
  /** Hex secp256k1 AntSeed peer public key. */
  peerPubkey: string;
  /** Hex ed25519 in-enclave evidence-signing public key (bound into report_data). */
  enclavePubkey: string;
  /** Hex bundle digest D, if bound. */
  bundleDigest?: string;
  /** Hex config hash, if bound. */
  configHash?: string;
  /** Hex nonce echoed back. */
  nonce: string;
  /** Base64 raw vendor quote bytes. */
  quote: string;
  /** 64-byte report_data, hex (verifier recomputes anyway; included for debugging). */
  reportDataHex: string;
  measurements: Record<string, string>;
  timestamp: number;
}

/** Response body for GET /pubkey: both the channel and evidence-signing keys. */
export interface PubkeyReply {
  /** Hex secp256k1 AntSeed peer public key (channel identity). */
  peerPubkey: string;
  /** Hex ed25519 in-enclave evidence-signing public key (bound into report_data). */
  enclavePubkey: string;
}

export interface EvidenceReply {
  status: number;
  /** `application/json` body to write. */
  body: EvidenceBundle | EvidenceDescriptor | PubkeyReply | { error: string };
}

const EVIDENCE_PATH = "/evidence";
const WELLKNOWN_PATH = "/.well-known/antseed-evidence";
const PUBKEY_PATH = "/pubkey";

/**
 * Handle a TEE-evidence request. Returns `null` for any path this handler does
 * not own (so the host dispatcher can fall through to /metadata etc.).
 *
 *   GET /pubkey                     -> { peerPubkey }
 *   GET /.well-known/antseed-evidence -> discovery descriptor
 *   GET /evidence?nonce=<hex>       -> fresh EvidenceBundle bound to the nonce
 */
export async function handleEvidenceRequest(
  url: string,
  ctx: EvidenceContext,
): Promise<EvidenceReply | null> {
  const { pathname, query } = splitUrl(url);

  if (pathname === PUBKEY_PATH) {
    return {
      status: 200,
      body: { peerPubkey: ctx.peerPubkey, enclavePubkey: ctx.enclavePubkey },
    };
  }

  if (pathname === WELLKNOWN_PATH) {
    const descriptor: EvidenceDescriptor = {
      scheme: "antseed-tee/v1",
      platform: ctx.attestation.platform,
      evidencePath: EVIDENCE_PATH,
      pubkeyPath: PUBKEY_PATH,
    };
    return { status: 200, body: descriptor };
  }

  if (pathname === EVIDENCE_PATH) {
    const nonce = query.get("nonce");
    if (!nonce || !/^[0-9a-fA-F]+$/.test(nonce) || nonce.length % 2 !== 0) {
      return { status: 400, body: { error: "missing or malformed 'nonce' (even-length hex)" } };
    }
    const bundle = await buildEvidence(ctx, nonce);
    return { status: 200, body: bundle };
  }

  return null; // not our path
}

async function buildEvidence(
  ctx: EvidenceContext,
  nonce: string,
): Promise<EvidenceBundle> {
  const quote: AttestationQuote = await ctx.attestation.generateQuote({
    peerPubkey: ctx.peerPubkey,
    enclavePubkey: ctx.enclavePubkey,
    nonce,
    bundleDigest: ctx.bundleDigest,
    configHash: ctx.configHash,
  });

  const bundle: EvidenceBundle = {
    scheme: "antseed-tee/v1",
    platform: quote.platform,
    peerPubkey: ctx.peerPubkey,
    enclavePubkey: ctx.enclavePubkey,
    nonce,
    quote: toBase64(quote.quote),
    reportDataHex: toHex(quote.reportData),
    measurements: quote.measurements,
    timestamp: Date.now(),
  };
  if (ctx.bundleDigest !== undefined) bundle.bundleDigest = ctx.bundleDigest;
  if (ctx.configHash !== undefined) bundle.configHash = ctx.configHash;
  return bundle;
}

function splitUrl(url: string): { pathname: string; query: URLSearchParams } {
  const qIdx = url.indexOf("?");
  if (qIdx === -1) return { pathname: url, query: new URLSearchParams() };
  return {
    pathname: url.slice(0, qIdx),
    query: new URLSearchParams(url.slice(qIdx + 1)),
  };
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}
