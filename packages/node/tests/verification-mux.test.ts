import { describe, expect, it } from 'vitest';
import { FrameDecoder } from '../src/p2p/message-protocol.js';
import type { PeerConnection } from '../src/p2p/connection-manager.js';
import { VerificationMux } from '../src/verification/index.js';
import type { ResponseAuthPayload } from '../src/types/protocol.js';

function makePayload(): ResponseAuthPayload {
  return {
    version: 1,
    requestId: 'req-1',
    buyerPeerId: '22'.repeat(20),
    sellerPeerId: '11'.repeat(20),
    advertisedService: 'claude-sonnet-test',
    provider: 'anthropic',
    statusCode: 200,
    requestHash: '0x' + 'aa'.repeat(32),
    responseHash: '0x' + 'bb'.repeat(32),
    responseStartedAt: 100,
    responseCompletedAt: 200,
    signature: 'cc'.repeat(65),
  };
}

describe('VerificationMux', () => {
  it('delivers response auth frames to request waiters', async () => {
    const sent: Uint8Array[] = [];
    const sender = new VerificationMux({
      send: (frame: Uint8Array) => sent.push(frame),
    } as unknown as PeerConnection);
    const receiver = new VerificationMux({
      send: () => {},
    } as unknown as PeerConnection);

    const waiter = receiver.waitForResponseAuth('req-1');
    sender.sendResponseAuth(makePayload());

    const decoder = new FrameDecoder();
    const frames = decoder.feed(sent[0]!);
    expect(frames).toHaveLength(1);
    await receiver.handleFrame(frames[0]!);

    await expect(waiter).resolves.toMatchObject({
      requestId: 'req-1',
      advertisedService: 'claude-sonnet-test',
    });
  });

  it('rejects pending response auth waits when closed', async () => {
    const mux = new VerificationMux({
      send: () => {},
    } as unknown as PeerConnection);

    const waiter = mux.waitForResponseAuth('req-1', 10_000);
    mux.close();

    await expect(waiter).rejects.toThrow('VerificationMux closed');
  });
});
