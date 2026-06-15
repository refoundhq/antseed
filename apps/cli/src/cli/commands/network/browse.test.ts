import assert from 'node:assert/strict';
import test from 'node:test';
import { collectVerificationLinks, peerMatchesServiceFilter } from './browse.js';
import type { PeerInfo } from '@antseed/node';

function peerWithServices(services: string[], providers: string[] = ['minimax']): PeerInfo {
  return {
    peerId: '0000000000000000000000000000000000000001' as PeerInfo['peerId'],
    lastSeen: Date.now(),
    providers,
    providerPricing: {
      minimax: {
        defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
        services: Object.fromEntries(
          services.map((service) => [service, { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }]),
        ),
      },
    },
  };
}

test('network browse service filter matches canonical service ids exactly', () => {
  assert.equal(peerMatchesServiceFilter(peerWithServices(['minimax-m3']), 'minimax-m3'), true);
});

test('network browse service filter matches punctuation and model-prefix variants', () => {
  const peer = peerWithServices(['minimax-m3']);
  assert.equal(peerMatchesServiceFilter(peer, 'minimax-3'), true);
  assert.equal(peerMatchesServiceFilter(peer, 'MiniMax M3'), true);
  assert.equal(peerMatchesServiceFilter(peer, 'minimax_m3'), true);
});

test('network browse service filter still matches providers', () => {
  assert.equal(peerMatchesServiceFilter(peerWithServices(['gpt-5.5'], ['market-router']), 'market router'), true);
});

test('network browse service filter rejects unrelated services', () => {
  assert.equal(peerMatchesServiceFilter(peerWithServices(['minimax-m3']), 'claude'), false);
});

test('network browse builds links for verified external claims only', () => {
  const peer = peerWithServices(['minimax-m3']);
  peer.verificationResults = {
    verified: false,
    checkedAtMs: 123,
    domains: [
      {
        domain: 'Example.com',
        peerId: peer.peerId,
        verified: true,
        method: 'dns-txt',
        checkedAtMs: 123,
        attempts: [{ method: 'dns-txt', verified: true }],
      },
      {
        domain: 'unverified.example',
        peerId: peer.peerId,
        verified: false,
        checkedAtMs: 123,
        attempts: [{ method: 'dns-txt', verified: false }],
      },
    ],
    github: [
      {
        username: 'OctoCat',
        repository: 'antseed-proof',
        peerId: peer.peerId,
        verified: true,
        checkedAtMs: 123,
      },
      {
        username: 'bad user',
        repository: 'repo',
        peerId: peer.peerId,
        verified: true,
        checkedAtMs: 123,
      },
    ],
  };

  assert.deepEqual(collectVerificationLinks(peer), [
    { kind: 'domain', label: 'example.com', href: 'https://example.com' },
    { kind: 'github', label: '@octocat/antseed-proof', href: 'https://github.com/octocat/antseed-proof' },
  ]);
});
