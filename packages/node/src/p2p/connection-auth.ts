import { randomBytes } from 'node:crypto';
import { SigningKey, computeAddress } from 'ethers';
import type { Wallet } from 'ethers';
import type { PeerId } from '../types/peer.js';
import { toPeerId } from '../types/peer.js';
import { signUtf8, verifyUtf8, recoverUtf8PublicKey } from './identity.js';

export type InitialWireType = 'intro' | 'hello';

export interface ConnectionAuthEnvelope {
  peerId: string;
  ts: number;
  nonce: string;
  sig: string;
}

export interface VerifyConnectionAuthOptions {
  type: InitialWireType;
  auth: ConnectionAuthEnvelope | null | undefined;
  nowMs?: number;
  maxSkewMs?: number;
  replayGuard?: NonceReplayGuard;
}

export interface VerifyConnectionAuthResult {
  ok: boolean;
  peerId?: PeerId;
  reason?: string;
  /**
   * Compressed secp256k1 public key (hex, no 0x) recovered from the verified
   * intro/hello signature. Present only when `ok` is true. This is the
   * cryptographically-authenticated channel identity key — the full pubkey
   * behind the EVM-address `peerId`.
   */
  peerPublicKey?: string;
}

export const INTRO_AUTH_MAX_SKEW_MS = 30_000;

const NONCE_SIZE_BYTES = 16;
const SIG_HEX_LEN = 130;
const NONCE_HEX_REGEX = /^[0-9a-f]{32}$/;
const SIG_HEX_REGEX = /^[0-9a-f]{130}$/;

function buildSigningPayload(
  type: InitialWireType,
  peerId: string,
  ts: number,
  nonce: string,
): string {
  return `${type}|${peerId}|${ts}|${nonce}`;
}

function buildReplayKey(peerId: PeerId, nonce: string): string {
  return `${peerId}:${nonce}`;
}

/**
 * Tracks recently seen nonces to reject replayed intro messages.
 */
export class NonceReplayGuard {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs = INTRO_AUTH_MAX_SKEW_MS * 2,
    private readonly maxEntries = 20_000,
  ) {}

  checkAndRemember(peerId: PeerId, nonce: string, nowMs = Date.now()): boolean {
    this.evictExpired(nowMs);
    const key = buildReplayKey(peerId, nonce);
    const existingExpiry = this.seen.get(key);
    if (existingExpiry && existingExpiry > nowMs) {
      return false;
    }

    this.seen.set(key, nowMs + this.ttlMs);
    if (this.seen.size > this.maxEntries) {
      const overflow = this.seen.size - this.maxEntries;
      let removed = 0;
      for (const oldestKey of this.seen.keys()) {
        this.seen.delete(oldestKey);
        removed++;
        if (removed >= overflow) {
          break;
        }
      }
    }
    return true;
  }

  private evictExpired(nowMs: number): void {
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= nowMs) {
        this.seen.delete(key);
      }
    }
  }
}

export function buildConnectionAuthEnvelope(
  type: InitialWireType,
  peerId: PeerId,
  wallet: Wallet,
  nowMs = Date.now(),
): ConnectionAuthEnvelope {
  const nonce = randomBytes(NONCE_SIZE_BYTES).toString('hex');
  const payload = buildSigningPayload(type, peerId, nowMs, nonce);
  const sig = signUtf8(wallet, payload);

  return {
    peerId,
    ts: nowMs,
    nonce,
    sig,
  };
}

export function verifyConnectionAuthEnvelope(
  options: VerifyConnectionAuthOptions,
): VerifyConnectionAuthResult {
  const nowMs = options.nowMs ?? Date.now();
  const maxSkewMs = options.maxSkewMs ?? INTRO_AUTH_MAX_SKEW_MS;
  const auth = options.auth;
  if (!auth || typeof auth !== 'object') {
    return { ok: false, reason: 'missing auth envelope' };
  }

  let peerId: PeerId;
  try {
    peerId = toPeerId(auth.peerId);
  } catch {
    return { ok: false, reason: 'invalid peerId' };
  }

  if (!Number.isInteger(auth.ts)) {
    return { ok: false, reason: 'invalid timestamp' };
  }
  if (Math.abs(nowMs - auth.ts) > maxSkewMs) {
    return { ok: false, reason: 'timestamp outside allowed skew' };
  }

  if (!NONCE_HEX_REGEX.test(auth.nonce)) {
    return { ok: false, reason: 'invalid nonce format' };
  }
  if (!SIG_HEX_REGEX.test(auth.sig) || auth.sig.length !== SIG_HEX_LEN) {
    return { ok: false, reason: 'invalid signature format' };
  }

  if (options.replayGuard && !options.replayGuard.checkAndRemember(peerId, auth.nonce, nowMs)) {
    return { ok: false, reason: 'replayed intro auth nonce' };
  }

  const payload = buildSigningPayload(options.type, peerId, auth.ts, auth.nonce);
  const valid = verifyUtf8(peerId, payload, auth.sig);
  if (!valid) {
    return { ok: false, reason: 'signature verification failed' };
  }

  // Recover the full compressed pubkey from the same verified signature so the
  // connection's authenticated channel identity key can be surfaced (e.g. for
  // TEE report_data binding). Recovery uses the identity of the verified
  // address, so it is guaranteed to derive back to `peerId`.
  const peerPublicKey = recoverUtf8PublicKey(payload, auth.sig) ?? undefined;

  return { ok: true, peerId, peerPublicKey };
}

/**
 * Authenticate a CANDIDATE secp256k1 public key against a known, authenticated
 * peerId (EVM address). Returns the normalized compressed pubkey (hex, no 0x)
 * iff it derives to `peerId`, else null.
 *
 * This is the buyer-side authentication path: the buyer is the connection
 * initiator and never receives a signed intro FROM the seller, so it cannot
 * recover the seller's pubkey from a signature. Instead it takes a candidate
 * pubkey (e.g. one served by the seller) and confirms it hashes to the seller's
 * authenticated peerId — a substituted key (MITM) cannot satisfy this, so the
 * result is the cryptographically-authenticated connected-peer pubkey.
 */
export function authenticatePeerPublicKey(
  peerId: string,
  candidatePubkeyHex: string,
): string | null {
  try {
    const normalized = candidatePubkeyHex.startsWith('0x')
      ? candidatePubkeyHex
      : '0x' + candidatePubkeyHex;
    const compressed = SigningKey.computePublicKey(normalized, true);
    const derivedAddress = computeAddress(compressed).slice(2).toLowerCase();
    if (derivedAddress !== peerId.toLowerCase()) return null;
    return compressed.replace(/^0x/, '');
  } catch {
    return null;
  }
}
