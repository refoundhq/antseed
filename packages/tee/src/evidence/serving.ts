import {
  handleEvidenceRequest,
  buildEvidence,
  type EvidenceContext,
  type EvidenceReply,
} from "./routes.js";

/**
 * DoS-hardening for the public evidence endpoint. Each `/evidence?nonce=` request
 * triggers a fresh quote generation (configfs-tsm / ioctl syscalls + an Intel-PCS
 * collateral fetch) — an unbounded, attacker-triggerable expensive op. These
 * bounds keep a public, unauthenticated endpoint from being weaponized while
 * preserving the buyer's per-nonce freshness semantics.
 */
export interface EvidenceServingOptions {
  /** Max simultaneous quote generations (the expensive op). Excess → 503. Default 4. */
  maxConcurrentQuotes?: number;
  /** Token-window rate limit: max `/evidence` requests per window. Excess → 429. Default 60. */
  rateLimitMax?: number;
  /** Rate-limit window in ms. Default 10_000. */
  rateLimitWindowMs?: number;
  /**
   * Cache a generated bundle by nonce for this long (ms) so rapid retries of the
   * SAME nonce return the cached bundle without re-generating. A unique nonce
   * always yields a fresh quote, so this only dedupes retries — freshness is
   * preserved. Default 5_000.
   */
  cacheTtlMs?: number;
  /** Clock injection (tests). */
  now?: () => number;
}

const EVIDENCE_PATH = "/evidence";

/**
 * Wrap the evidence routes with rate limiting, bounded quote-generation
 * concurrency, and a short per-nonce response cache. Cheap paths (`/pubkey`,
 * `/.well-known/antseed-evidence`) are served directly without limiting; only the
 * expensive `/evidence` path is bounded. Returns the same `(url) => reply|null`
 * handler shape the connection-manager dispatcher expects.
 */
export function createEvidenceHandler(
  ctx: EvidenceContext,
  opts: EvidenceServingOptions = {},
): (url: string) => Promise<EvidenceReply | null> {
  const maxConcurrent = opts.maxConcurrentQuotes ?? 4;
  const rlMax = opts.rateLimitMax ?? 60;
  const rlWindowMs = opts.rateLimitWindowMs ?? 10_000;
  const ttlMs = opts.cacheTtlMs ?? 5_000;
  const now = opts.now ?? (() => Date.now());

  let inflight = 0;
  let windowStart = now();
  let windowCount = 0;
  const cache = new Map<string, { reply: EvidenceReply; expiry: number }>();

  return async (url: string): Promise<EvidenceReply | null> => {
    const qIdx = url.indexOf("?");
    const pathname = qIdx === -1 ? url : url.slice(0, qIdx);

    // Cheap paths: served directly, no limiting.
    if (pathname !== EVIDENCE_PATH) return handleEvidenceRequest(url, ctx);

    const t = now();

    // 1. Token-window rate limit (global).
    if (t - windowStart >= rlWindowMs) {
      windowStart = t;
      windowCount = 0;
    }
    if (windowCount >= rlMax) {
      return { status: 429, body: { error: "evidence rate limit exceeded; retry shortly" } };
    }
    windowCount++;

    // 2. Validate the nonce (mirror handleEvidenceRequest).
    const query = new URLSearchParams(qIdx === -1 ? "" : url.slice(qIdx + 1));
    const nonce = query.get("nonce");
    if (!nonce || !/^[0-9a-fA-F]+$/.test(nonce) || nonce.length % 2 !== 0) {
      return { status: 400, body: { error: "missing or malformed 'nonce' (even-length hex)" } };
    }

    // 3. Per-nonce response cache (dedupes retries of the same nonce).
    const hit = cache.get(nonce);
    if (hit && hit.expiry > t) return hit.reply;

    // 4. Bounded quote-generation concurrency.
    if (inflight >= maxConcurrent) {
      return {
        status: 503,
        body: { error: "evidence server busy (quote concurrency limit); retry shortly" },
      };
    }
    inflight++;
    try {
      const reply: EvidenceReply = { status: 200, body: await buildEvidence(ctx, nonce) };
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
