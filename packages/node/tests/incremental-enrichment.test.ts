import { describe, expect, it, vi } from 'vitest';
import { AntseedNode, type PeerInfo } from '../src/node.js';

function makePeer(peerId = 'a'.repeat(40)): PeerInfo {
  return {
    peerId: peerId as PeerInfo['peerId'],
    providers: ['openai'],
    lastSeen: Date.now(),
  };
}

describe('AntseedNode incremental discovery enrichment', () => {
  it('emits an enriched peer update after a partial metadata-only discovery event', async () => {
    const node = new AntseedNode({ role: 'buyer' });
    const peer = makePeer();
    const nowSec = Math.floor(Date.now() / 1000);
    const discovered = vi.fn();

    node.on('peers:discovered', discovered);
    (node as any)._started = true;
    (node as any)._stakingClient = {
      getAgentId: vi.fn().mockResolvedValue(123),
      getStake: vi.fn().mockResolvedValue(10_000_000n),
      getStakedAt: vi.fn().mockResolvedValue(nowSec - 86_400),
    };
    (node as any)._channelsClient = {
      getAgentStats: vi.fn().mockResolvedValue({
        channelCount: 25,
        ghostCount: 0,
        totalVolumeUsdc: 50_000_000n,
        lastSettledAt: nowSec,
      }),
    };

    (node as any)._queuePartialPeerEnrichment([peer]);
    await (node as any)._partialPeerEnrichmentChain;

    expect(discovered).toHaveBeenCalledTimes(1);
    const [[peers]] = discovered.mock.calls as [[PeerInfo[]]];
    expect(peers).toHaveLength(1);
    expect(peers[0]?.peerId).toBe(peer.peerId);
    expect(peers[0]?.onChainAgentId).toBe(123);
    expect(peers[0]?.onChainChannelCount).toBe(25);
    expect(peers[0]?.onChainTotalVolumeUsdcMicros).toBe(50_000_000);
    expect(peers[0]?.onChainStatsFetchedAt).toEqual(expect.any(Number));
    expect(peers[0]?.onChainReputationScore).toEqual(expect.any(Number));
  });
});
