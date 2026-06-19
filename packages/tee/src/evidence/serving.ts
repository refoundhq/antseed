import {
  handleEvidenceRequest,
  buildEvidence,
  type EvidenceContext,
} from "./routes.js";
import { buildLauncherEvidence, type LauncherEvidenceContext } from "./builder.js";
import { EVIDENCE_SCHEMA_LAUNCHER } from "./document.js";

/**
 * DoS-hardening for the public evidence endpoint. Each `/evidence?nonce=` request
 * triggers a fresh quote generation (configfs-tsm / ioctl syscalls + an Intel-PCS
 * collateral fetch) — an unbounded, attacker-triggerable expensive op. These
 * bounds keep a public, unauthenticated endpoint from being weaponized while
 * preserving the buyer's per-nonce freshness semantics. Shared by the v1 and the
 * launcher evidence handlers.
 */
export interface EvidenceServingOptions {
  /** Max simultaneous quote generations (the expensive op). Excess → 503. Default 4. */
  maxConcurrentQuotes?: number;
  /** Token-window rate limit: max `/evidence` requests per window. Excess → 429. Default 60. */
  rateLimitMax?: number;
  /** Rate-limit window in ms. Default 10_000. */
  rateLimitWindowMs?: number;
  /** Cache a generated bundle by nonce for this long (ms) to dedupe retries. Default 5_000. */
  cacheTtlMs?: number;
  /** Clock injection (tests). */
  now?: () => number;
}

/** Loosely-typed reply the connection-manager dispatcher consumes (body is JSON-serialized). */
export interface ServeReply {
  status: number;
  body: unknown;
}

const EVIDENCE_PATH = "/evidence";
const PUBKEY_PATH = "/pubkey";
const WELLKNOWN_PATH = "/.well-known/antseed-evidence";

/**
 * The shared hardened core: cheap paths are served directly; only `/evidence`
 * (which triggers a real quote) is rate-limited, concurrency-bounded, and
 * per-nonce cached. `buildForNonce` produces the (expensive) evidence reply.
 */
function hardenedHandler(
  opts: EvidenceServingOptions,
  cheap: (pathname: string, url: string) => Promise<ServeReply | null>,
  buildForNonce: (nonce: string) => Promise<ServeReply>,
): (url: string) => Promise<ServeReply | null> {
  const maxConcurrent = opts.maxConcurrentQuotes ?? 4;
  const rlMax = opts.rateLimitMax ?? 60;
  const rlWindowMs = opts.rateLimitWindowMs ?? 10_000;
  const ttlMs = opts.cacheTtlMs ?? 5_000;
  const now = opts.now ?? (() => Date.now());

  let inflight = 0;
  let windowStart = now();
  let windowCount = 0;
  const cache = new Map<string, { reply: ServeReply; expiry: number }>();

  return async (url: string): Promise<ServeReply | null> => {
    const qIdx = url.indexOf("?");
    const pathname = qIdx === -1 ? url : url.slice(0, qIdx);
    if (pathname !== EVIDENCE_PATH) return cheap(pathname, url);

    const t = now();
    if (t - windowStart >= rlWindowMs) {
      windowStart = t;
      windowCount = 0;
    }
    if (windowCount >= rlMax) {
      return { status: 429, body: { error: "evidence rate limit exceeded; retry shortly" } };
    }
    windowCount++;

    const query = new URLSearchParams(qIdx === -1 ? "" : url.slice(qIdx + 1));
    const nonce = query.get("nonce");
    if (!nonce || !/^[0-9a-fA-F]+$/.test(nonce) || nonce.length % 2 !== 0) {
      return { status: 400, body: { error: "missing or malformed 'nonce' (even-length hex)" } };
    }

    const hit = cache.get(nonce);
    if (hit && hit.expiry > t) return hit.reply;

    if (inflight >= maxConcurrent) {
      return { status: 503, body: { error: "evidence server busy (quote concurrency limit); retry shortly" } };
    }
    inflight++;
    try {
      const reply = await buildForNonce(nonce);
      cache.set(nonce, { reply, expiry: t + ttlMs });
      if (cache.size > 256) {
        for (const [k, v] of cache) if (v.expiry <= t) cache.delete(k);
      }
      return reply;
    } finally {
      inflight--;
    }
  };
}

/** Hardened handler for the v1 evidence bundle (legacy schema). */
export function createEvidenceHandler(
  ctx: EvidenceContext,
  opts: EvidenceServingOptions = {},
): (url: string) => Promise<ServeReply | null> {
  return hardenedHandler(
    opts,
    (_pathname, url) => handleEvidenceRequest(url, ctx),
    async (nonce) => ({ status: 200, body: await buildEvidence(ctx, nonce) }),
  );
}

/**
 * Hardened handler for the launcher evidence schema. `/evidence?nonce=` returns a
 * freshly built, enclave-signed {@link EvidenceDocument} bound to the nonce;
 * `/pubkey` returns the peer + enclave + (optional) channel keys; the well-known
 * descriptor advertises the launcher scheme. `timestamp` is stamped per request.
 */
export function createLauncherEvidenceHandler(
  ctx: Omit<LauncherEvidenceContext, "timestamp">,
  opts: EvidenceServingOptions = {},
): (url: string) => Promise<ServeReply | null> {
  const now = opts.now ?? (() => Date.now());
  const cheap = async (pathname: string): Promise<ServeReply | null> => {
    if (pathname === PUBKEY_PATH) {
      return {
        status: 200,
        body: {
          peerPubkey: ctx.peerPubkey,
          enclavePubkey: ctx.enclavePubkey,
          ...(ctx.channelPubkey ? { channelPubkey: ctx.channelPubkey, channelKeyAlg: "x25519" } : {}),
        },
      };
    }
    if (pathname === WELLKNOWN_PATH) {
      return {
        status: 200,
        body: {
          scheme: EVIDENCE_SCHEMA_LAUNCHER,
          platform: ctx.platform,
          evidencePath: EVIDENCE_PATH,
          pubkeyPath: PUBKEY_PATH,
        },
      };
    }
    return null;
  };
  return hardenedHandler(opts, cheap, async (nonce) => ({
    status: 200,
    body: await buildLauncherEvidence({ ...ctx, timestamp: now() }, nonce),
  }));
}
