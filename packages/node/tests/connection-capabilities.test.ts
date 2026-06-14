import net, { type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { buildConnectionAuthEnvelope } from '../src/p2p/connection-auth.js';
import { ConnectionManager, type PeerConnection } from '../src/p2p/connection-manager.js';
import { identityFromPrivateKeyHex } from '../src/p2p/identity.js';
import { CONNECTION_CAPABILITY_RESPONSE_AUTH_V1 } from '../src/types/protocol.js';

const sellerIdentity = identityFromPrivateKeyHex('11'.repeat(32));
const buyerIdentity = identityFromPrivateKeyHex('22'.repeat(32));

const managers: ConnectionManager[] = [];
const sockets: Socket[] = [];

function trackManager(manager: ConnectionManager): ConnectionManager {
  managers.push(manager);
  return manager;
}

function waitForConnection(manager: ConnectionManager): Promise<PeerConnection> {
  return new Promise((resolve) => manager.once('connection', resolve));
}

function connectSocket(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    sockets.push(socket);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

describe('connection capabilities', () => {
  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.destroy();
    }
    for (const manager of managers.splice(0)) {
      manager.closeAll();
      await manager.stopListening();
    }
  });

  it('treats peers without capabilities as old clients', async () => {
    const seller = trackManager(new ConnectionManager());
    seller.setLocalIdentity(sellerIdentity);
    await seller.startListening({ peerId: sellerIdentity.peerId, host: '127.0.0.1', port: 0 });

    const inbound = waitForConnection(seller);
    const socket = await connectSocket(seller.getListeningPort()!);
    socket.write(JSON.stringify({
      type: 'intro',
      auth: buildConnectionAuthEnvelope('intro', buyerIdentity.peerId, buyerIdentity.wallet),
    }) + '\n');

    const conn = await inbound;
    expect(conn.remotePeerId).toBe(buyerIdentity.peerId);
    expect(conn.hasRemoteCapability(CONNECTION_CAPABILITY_RESPONSE_AUTH_V1)).toBe(false);
  });

  it('records response-auth support from new clients', async () => {
    const seller = trackManager(new ConnectionManager());
    const buyer = trackManager(new ConnectionManager());
    seller.setLocalIdentity(sellerIdentity);
    buyer.setLocalIdentity(buyerIdentity);
    await seller.startListening({ peerId: sellerIdentity.peerId, host: '127.0.0.1', port: 0 });

    const inbound = waitForConnection(seller);
    buyer.createConnection({
      remotePeerId: sellerIdentity.peerId,
      isInitiator: true,
      endpoint: { host: '127.0.0.1', port: seller.getListeningPort()! },
    });

    const conn = await inbound;
    expect(conn.remotePeerId).toBe(buyerIdentity.peerId);
    expect(conn.hasRemoteCapability(CONNECTION_CAPABILITY_RESPONSE_AUTH_V1)).toBe(true);
  });
});
