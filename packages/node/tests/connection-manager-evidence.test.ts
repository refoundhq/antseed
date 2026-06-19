import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionManager } from '../src/p2p/connection-manager.js';
import { identityFromPrivateKeyHex } from '../src/p2p/identity.js';

const identity = identityFromPrivateKeyHex('33'.repeat(32));
const managers: ConnectionManager[] = [];

afterEach(async () => {
  for (const m of managers.splice(0)) {
    m.closeAll();
    await m.stopListening();
  }
});

/** Issue a single GET over a fresh socket and return the raw HTTP response. */
function httpGet(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\n\r\n`);
    });
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => (data += chunk));
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

function parseBody(raw: string): unknown {
  const idx = raw.indexOf('\r\n\r\n');
  return JSON.parse(raw.slice(idx + 4));
}

describe('connection-manager evidence HTTP dispatch', () => {
  it('serves the evidence handler before /metadata, falling through otherwise', async () => {
    const cm = new ConnectionManager();
    managers.push(cm);
    cm.setMetadataProvider(() => ({ kind: 'metadata' }));
    cm.setEvidenceHandler(async (url) => {
      if (url === '/evidence-test') return { status: 200, body: { kind: 'evidence' } };
      return null; // not ours → fall through
    });
    await cm.startListening({ peerId: identity.peerId, port: 0 });
    const port = cm.getListeningPort()!;

    // Evidence path: handled by the evidence handler.
    const evid = await httpGet(port, '/evidence-test');
    expect(evid).toContain('200 OK');
    expect(parseBody(evid)).toEqual({ kind: 'evidence' });

    // /metadata: evidence handler returns null → metadata served.
    const meta = await httpGet(port, '/metadata');
    expect(meta).toContain('200 OK');
    expect(parseBody(meta)).toEqual({ kind: 'metadata' });

    // Unrelated path → 404 from the metadata fallback.
    const other = await httpGet(port, '/nope');
    expect(other).toContain('404 Not Found');
  });

  it('still serves /metadata when no evidence handler is registered', async () => {
    const cm = new ConnectionManager();
    managers.push(cm);
    cm.setMetadataProvider(() => ({ kind: 'metadata' }));
    await cm.startListening({ peerId: identity.peerId, port: 0 });
    const port = cm.getListeningPort()!;

    const meta = await httpGet(port, '/metadata');
    expect(meta).toContain('200 OK');
    expect(parseBody(meta)).toEqual({ kind: 'metadata' });
  });
});
