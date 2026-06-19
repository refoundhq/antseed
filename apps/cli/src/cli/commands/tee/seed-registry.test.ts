import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RegistryClient, generateRegistryKeypair } from '@antseed/tee/registry';
import type { AttestationQuote } from '@antseed/tee/attestation';
import { buildSignedValidSet } from './seed-registry.js';

/**
 * `antseed tee seed-registry` core, exercised against the REAL Intel TDX quote
 * fixture (the dcap-qvl test vector committed in @antseed/tee). No network, no
 * mocks: load the genuine quote + collateral, DCAP-verify, derive the canonical
 * measurement, sign a ValidSet, and prove the buyer's RegistryClient accepts the
 * seeded measurement — and rejects a set signed by a different (unpinned) signer.
 */

// The fixture lives in the @antseed/tee package source; resolve it from the
// compiled test location (dist mirrors src depth, so the relative hops match).
const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(
  HERE,
  '..', '..', '..', '..', '..', '..',
  'packages', 'tee', 'src', 'verifier', '__fixtures__',
);
// Sample collateral is valid 2025-06-19..2025-07-19; pin DCAP time inside it.
const NOW_SECS = Math.floor(Date.parse('2025-06-20T00:00:00Z') / 1000);

function loadSampleQuote(): AttestationQuote {
  const raw = new Uint8Array(
    Buffer.from(readFileSync(join(FIX, 'tdx_quote.b64'), 'utf8'), 'base64'),
  );
  const collateral = JSON.parse(
    readFileSync(join(FIX, 'tdx_quote_collateral.json'), 'utf8'),
  ) as Record<string, string>;
  return { platform: 'tdx', quote: raw, reportData: new Uint8Array(0), measurements: {}, collateral };
}

test('seed-registry seeds a signed ValidSet the buyer RegistryClient accepts', () => {
  const { publicKeyHex, privateKeyPem } = generateRegistryKeypair();

  const { set, measurement, tcbVerdict } = buildSignedValidSet({
    quote: loadSampleQuote(),
    privateKeyPem,
    nowSecs: NOW_SECS,
  });

  assert.equal(tcbVerdict, 'current');
  assert.equal(set.signer, publicKeyHex);
  assert.equal(set.version, 1);
  assert.deepEqual(set.entries, [{ platform: 'tdx', measurement, status: 'active' }]);

  // Buyer pins the seeding authority and accepts the seeded measurement.
  const buyer = new RegistryClient({ pinnedSigner: publicKeyHex, policy: { nowSecs: NOW_SECS } });
  buyer.loadFromObject(set);
  assert.equal(buyer.isApproved('tdx', measurement), true);
});

test('seed-registry: a buyer pinned to a DIFFERENT signer rejects the set (fail-closed)', () => {
  const { privateKeyPem } = generateRegistryKeypair();
  const { set, measurement } = buildSignedValidSet({
    quote: loadSampleQuote(),
    privateKeyPem,
    nowSecs: NOW_SECS,
  });

  const otherSigner = generateRegistryKeypair().publicKeyHex;
  const buyer = new RegistryClient({ pinnedSigner: otherSigner, policy: { nowSecs: NOW_SECS } });
  assert.throws(() => buyer.loadFromObject(set));
  assert.equal(buyer.isApproved('tdx', measurement), false);
});

test('seed-registry merges a re-seed into an existing set and bumps the version', () => {
  const { privateKeyPem } = generateRegistryKeypair();
  const first = buildSignedValidSet({ quote: loadSampleQuote(), privateKeyPem, nowSecs: NOW_SECS });

  // Re-seed the same seller into the existing set: same measurement de-dupes,
  // version bumps, signature stays valid under the same signer.
  const second = buildSignedValidSet({
    quote: loadSampleQuote(),
    privateKeyPem,
    existing: first.set,
    nowSecs: NOW_SECS,
  });

  assert.equal(second.set.version, first.set.version + 1);
  assert.equal(second.set.entries.length, 1); // de-duped on (platform, measurement)
  assert.equal(second.set.signer, first.set.signer);

  const buyer = new RegistryClient({ pinnedSigner: second.set.signer, policy: { nowSecs: NOW_SECS } });
  buyer.loadFromObject(second.set);
  assert.equal(buyer.isApproved('tdx', second.measurement), true);
});

test('seed-registry refuses to seed a tampered (non-genuine) quote', () => {
  const { privateKeyPem } = generateRegistryKeypair();
  const quote = loadSampleQuote();
  quote.quote[600] = (quote.quote[600] ?? 0) ^ 0xff; // flip a byte in the signed TD report

  assert.throws(() => buildSignedValidSet({ quote, privateKeyPem, nowSecs: NOW_SECS }));
});

test('seed-registry consumes collateral from the evidence bundle (no --collateral file)', () => {
  // Simulate the seeder reading an evidence bundle whose `collateral` field the
  // seller embedded: reconstruct the quote with that inline collateral and seed.
  // No --collateral path is involved — the bundle is self-sufficient.
  const { raw, collateral } = (() => {
    const r = new Uint8Array(
      Buffer.from(readFileSync(join(FIX, 'tdx_quote.b64'), 'utf8'), 'base64'),
    );
    const c = JSON.parse(
      readFileSync(join(FIX, 'tdx_quote_collateral.json'), 'utf8'),
    ) as Record<string, string>;
    return { raw: r, collateral: c };
  })();
  const bundle = { platform: 'tdx', quote: Buffer.from(raw).toString('base64'), collateral };

  const quoteFromBundle: AttestationQuote = {
    platform: 'tdx',
    quote: new Uint8Array(Buffer.from(bundle.quote, 'base64')),
    reportData: new Uint8Array(0),
    measurements: {},
    collateral: bundle.collateral, // straight from the bundle, no file
  };

  const { publicKeyHex, privateKeyPem } = generateRegistryKeypair();
  const { set, measurement, tcbVerdict } = buildSignedValidSet({
    quote: quoteFromBundle,
    privateKeyPem,
    nowSecs: NOW_SECS,
  });

  assert.equal(tcbVerdict, 'current');
  assert.deepEqual(set.entries, [{ platform: 'tdx', measurement, status: 'active' }]);
  const buyer = new RegistryClient({ pinnedSigner: publicKeyHex, policy: { nowSecs: NOW_SECS } });
  buyer.loadFromObject(set);
  assert.equal(buyer.isApproved('tdx', measurement), true);
});

test('seed-registry seeds approved binaries + launcher capabilities the buyer can use', () => {
  const { publicKeyHex, privateKeyPem } = generateRegistryKeypair();
  const { set } = buildSignedValidSet({
    quote: loadSampleQuote(),
    privateKeyPem,
    nowSecs: NOW_SECS,
    binaries: [{ digest: 'ab'.repeat(32), version: '1.2.0', tag: 'stable', status: 'active' }],
    entryCapabilities: ['mem-enc'],
    launcherVersion: '1.0.0',
  });

  const buyer = new RegistryClient({ pinnedSigner: publicKeyHex, policy: { nowSecs: NOW_SECS } });
  buyer.loadFromObject(set);

  // approved binary visible + governance-vouched launcher capability/version on the entry
  assert.equal(buyer.approveBinary({ digest: 'ab'.repeat(32) }).approved, true);
  assert.equal(buyer.approveBinary({ digest: 'ff'.repeat(32) }).approved, false);
  const entry = buyer.findApprovedEntry('tdx', set.entries[0]!.measurement);
  assert.ok(entry?.capabilities?.includes('mem-enc'));
  assert.equal(entry?.launcherVersion, '1.0.0');
});
