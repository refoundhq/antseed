import assert from 'node:assert/strict';
import test from 'node:test';
import { peerMatchesServiceFilter } from './browse.js';
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
