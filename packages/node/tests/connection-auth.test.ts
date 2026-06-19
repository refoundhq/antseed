import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Wallet } from 'ethers';
import { toPeerId } from '../src/types/peer.js';
import { bytesToHex } from '../src/utils/hex.js';
import {
  NonceReplayGuard,
  buildConnectionAuthEnvelope,
  verifyConnectionAuthEnvelope,
  authenticatePeerPublicKey,
} from '../src/p2p/connection-auth.js';
import type { Identity } from '../src/p2p/identity.js';

function createIdentity(): Identity {
  const privateKey = randomBytes(32);
  const wallet = new Wallet('0x' + bytesToHex(privateKey));
  const peerId = toPeerId(wallet.address.slice(2).toLowerCase());
  return { peerId, privateKey, wallet };
}

describe('connection-auth', () => {
  it('accepts valid signed intro auth', () => {
    const { peerId, wallet } = createIdentity();
    const nowMs = 1_700_000_000_000;
    const auth = buildConnectionAuthEnvelope('intro', peerId, wallet, nowMs);

    const result = verifyConnectionAuthEnvelope({
      type: 'intro',
      auth,
      nowMs,
    });

    expect(result.ok).toBe(true);
    expect(result.peerId).toBe(peerId);
  });

  it('recovers the connected peer pubkey from a verified intro', () => {
    const { peerId, wallet } = createIdentity();
    const nowMs = 1_700_000_000_000;
    const auth = buildConnectionAuthEnvelope('intro', peerId, wallet, nowMs);

    const result = verifyConnectionAuthEnvelope({ type: 'intro', auth, nowMs });

    expect(result.ok).toBe(true);
    // The recovered compressed pubkey matches the wallet's, and authenticates
    // back to the same peerId.
    expect(result.peerPublicKey).toBe(
      wallet.signingKey.compressedPublicKey.replace(/^0x/, ''),
    );
    expect(authenticatePeerPublicKey(peerId, result.peerPublicKey!)).toBe(
      result.peerPublicKey,
    );
  });

  it('authenticatePeerPublicKey: matching key derives to peerId, substituted key fails', () => {
    const a = createIdentity();
    const b = createIdentity();
    const aPubkey = a.wallet.signingKey.compressedPublicKey.replace(/^0x/, '');
    const bPubkey = b.wallet.signingKey.compressedPublicKey.replace(/^0x/, '');

    // The real key derives to a's peerId (tolerating a 0x prefix too).
    expect(authenticatePeerPublicKey(a.peerId, aPubkey)).toBe(aPubkey);
    expect(authenticatePeerPublicKey(a.peerId, '0x' + aPubkey)).toBe(aPubkey);
    // A substituted (MITM) key — another peer's key — does not derive to a's peerId.
    expect(authenticatePeerPublicKey(a.peerId, bPubkey)).toBeNull();
    // Garbage is rejected, not thrown.
    expect(authenticatePeerPublicKey(a.peerId, 'not-hex')).toBeNull();
  });

  it('rejects payload type mismatch', () => {
    const { peerId, wallet } = createIdentity();
    const nowMs = 1_700_000_000_000;
    const auth = buildConnectionAuthEnvelope('intro', peerId, wallet, nowMs);

    const result = verifyConnectionAuthEnvelope({
      type: 'hello',
      auth,
      nowMs,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('signature');
  });

  it('rejects stale auth timestamps', () => {
    const { peerId, wallet } = createIdentity();
    const auth = buildConnectionAuthEnvelope('hello', peerId, wallet, 1_000);

    const result = verifyConnectionAuthEnvelope({
      type: 'hello',
      auth,
      nowMs: 100_000,
      maxSkewMs: 30_000,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('timestamp');
  });

  it('rejects replayed nonces when replay guard is enabled', () => {
    const { peerId, wallet } = createIdentity();
    const guard = new NonceReplayGuard();
    const nowMs = 1_700_000_000_000;
    const auth = buildConnectionAuthEnvelope('intro', peerId, wallet, nowMs);

    const first = verifyConnectionAuthEnvelope({
      type: 'intro',
      auth,
      nowMs,
      replayGuard: guard,
    });
    const second = verifyConnectionAuthEnvelope({
      type: 'intro',
      auth,
      nowMs,
      replayGuard: guard,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.reason).toContain('replayed');
  });
});
