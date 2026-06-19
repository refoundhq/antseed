import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer, type Server } from 'node:http'
import {
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto'
import type { PeerInfo } from '@antseed/node'
import { MockAttestation, MOCK_MEASUREMENT } from '@antseed/tee/attestation'
import { handleEvidenceRequest, type EvidenceContext } from '@antseed/tee/evidence'
import { createLauncherEvidenceHandler, type ClaimId } from '@antseed/tee'
import { canonicalizeSignedPayload } from '@antseed/tee/registry'
import type { ValidSet } from '@antseed/tee/registry'
import { verifyTeeSeller, isTeeSeller, resolveEvidenceBaseUrl, type TeeVerifyOptions } from './tee-verify.js'

// --- ed25519 signer (mirrors @antseed/tee registry/test-helpers, which is not
// part of the package's public exports) ---
function rawEd25519PublicKeyHex(publicKey: KeyObject): string {
  const der = publicKey.export({ format: 'der', type: 'spki' }) as Buffer
  return Buffer.from(der.subarray(der.length - 32)).toString('hex')
}

function signValidSet(partial: Omit<ValidSet, 'signer' | 'signature'>): { set: ValidSet; signerHex: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const signerHex = rawEd25519PublicKeyHex(publicKey)
  const unsigned: ValidSet = { ...partial, signer: signerHex, signature: '' }
  const signature = cryptoSign(null, Buffer.from(canonicalizeSignedPayload(unsigned)), privateKey).toString('hex')
  return { set: { ...unsigned, signature }, signerHex }
}

// The mock measurement is the canonical measurement the verifier extracts.
function approvedRegistryFile(): { set: ValidSet } {
  return signValidSet({
    version: 1,
    entries: [{ platform: 'mock', measurement: String(MOCK_MEASUREMENT), status: 'active' }],
  })
}

function emptyRegistryFile(): { set: ValidSet } {
  return signValidSet({ version: 1, entries: [] })
}

const LAUNCHER_BINARY_DIGEST = 'ab'.repeat(32)

/** A signed ValidSet approving the mock launcher measurement + the seller binary. */
function launcherRegistryFile(): { set: ValidSet } {
  return signValidSet({
    version: 1,
    entries: [
      {
        platform: 'mock',
        measurement: String(MOCK_MEASUREMENT),
        status: 'active',
        capabilities: ['no-operator-shell'],
      },
    ],
    binaries: [{ digest: LAUNCHER_BINARY_DIGEST, version: '1.2.0', tag: 'stable', status: 'active' }],
  })
}

const SELLER_PUBKEY = 'aa'.repeat(33) // 66-hex compressed-key-shaped placeholder
const SELLER_ENCLAVE_PUBKEY = 'ed'.repeat(44) // ed25519 spki/der-shaped placeholder

/**
 * Spin up a mock seller HTTP server serving the real TEE evidence routes via
 * @antseed/tee. `tamper` mutates the bundle to simulate a failed seller;
 * `pubkeyTamper` mutates the /pubkey response (e.g. a MITM-swapped enclave key).
 */
async function startMockSeller(opts: {
  pubkey?: string
  enclavePubkey?: string
  tamper?: (body: Record<string, unknown>) => void
  pubkeyTamper?: (body: Record<string, unknown>) => void
}): Promise<{ server: Server; baseUrl: string }> {
  const ctx: EvidenceContext = {
    attestation: new MockAttestation(),
    peerPubkey: opts.pubkey ?? SELLER_PUBKEY,
    enclavePubkey: opts.enclavePubkey ?? SELLER_ENCLAVE_PUBKEY,
  }
  const server = createServer((req, res) => {
    void (async () => {
      const reply = await handleEvidenceRequest(req.url ?? '/', ctx)
      if (!reply) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const body = reply.body as Record<string, unknown>
      if (opts.tamper && (req.url ?? '').startsWith('/evidence')) {
        opts.tamper(body)
      }
      if (opts.pubkeyTamper && (req.url ?? '') === '/pubkey') {
        opts.pubkeyTamper(body)
      }
      res.writeHead(reply.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return { server, baseUrl: `127.0.0.1:${port}` }
}

/** A mock seller serving the LAUNCHER evidence schema (enclave-signed document). */
async function startMockLauncherSeller(
  opts: { binaryDigest?: string } = {},
): Promise<{ server: Server; baseUrl: string }> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const enclavePubkey = publicKey.export({ type: 'spki', format: 'der' }).toString('hex')
  const claims: ClaimId[] = [
    'hardware-genuine', 'channel-key-bound', 'approved-launcher', 'approved-binary', 'binary-active',
  ]
  const handler = createLauncherEvidenceHandler({
    platform: 'mock',
    attestation: new MockAttestation(),
    claims,
    peerPubkey: SELLER_PUBKEY,
    enclavePubkey,
    enclavePrivateKey: privateKey,
    channelPubkey: 'cc'.repeat(32),
    launcherMeasurement: String(MOCK_MEASUREMENT),
    antseedBinary: { digest: opts.binaryDigest ?? LAUNCHER_BINARY_DIGEST, version: '1.2.0', tag: 'stable' },
  })
  const server = createServer((req, res) => {
    void (async () => {
      const reply = await handler(req.url ?? '/')
      if (!reply) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      res.writeHead(reply.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(reply.body))
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return { server, baseUrl: `127.0.0.1:${port}` }
}

function teePeer(publicAddress: string): PeerInfo {
  return {
    peerId: ('ab'.repeat(20)) as PeerInfo['peerId'],
    lastSeen: Date.now(),
    providers: ['openai'],
    publicAddress,
    providerServiceCategories: {
      openai: { services: { 'gpt-4o': ['tee'] } },
    },
  }
}

function plainPeer(): PeerInfo {
  return {
    peerId: ('cd'.repeat(20)) as PeerInfo['peerId'],
    lastSeen: Date.now(),
    providers: ['openai'],
    publicAddress: '127.0.0.1:1',
  }
}

const baseOpts = (over: Partial<TeeVerifyOptions>): TeeVerifyOptions => ({
  requireTee: false,
  allowMock: true,
  fetchTimeoutMs: 2000,
  // Default resolver: treat the seller's served secp256k1 key as authenticated.
  // (The real resolver derives the key to the peerId; tests that exercise the
  // failure path override this with a rejecting resolver.)
  authenticatePeerPubkey: (_peerId, candidate) => candidate,
  ...over,
})

test('resolveEvidenceBaseUrl derives the evidence base from a DHT-announced publicAddress', () => {
  // The TEE evidence fetch derives its base URL from the seller's
  // DHT-announced publicAddress, so it reaches the discovered seller for
  // attestation evidence.
  assert.equal(resolveEvidenceBaseUrl(teePeer('34.10.10.10:6882')), 'http://34.10.10.10:6882')

  // No publicAddress (e.g. unresolved peer) yields null — nothing to fetch from.
  const noAddr: PeerInfo = {
    peerId: ('ef'.repeat(20)) as PeerInfo['peerId'],
    lastSeen: Date.now(),
    providers: [],
  }
  assert.equal(resolveEvidenceBaseUrl(noAddr), null)
})

test('verified TEE seller is accepted (verdict verified, allowed)', async () => {
  const { server, baseUrl } = await startMockSeller({})
  const reg = approvedRegistryFile()
  const regFile = await writeTmpRegistry(reg.set)
  try {
    const outcome = await verifyTeeSeller(
      teePeer(baseUrl),
      baseOpts({ requireTee: true, registryUrl: regFile, pinnedRegistrySigner: reg.set.signer }),
    )
    assert.equal(outcome.isTeeSeller, true)
    assert.ok(outcome.result, 'result present')
    assert.equal(outcome.result!.verdict, 'verified')
    assert.equal(outcome.allowed, true)
    // tri-state checklist + notProven surfaced
    assert.equal(outcome.result!.checks.length, 3)
    assert.ok(outcome.result!.notProven.length > 0)
  } finally {
    server.close()
  }
})

test('tampered seller is rejected when --require-tee', async () => {
  // Tamper report_data so check #3 (channel/nonce binding) fails.
  const { server, baseUrl } = await startMockSeller({
    tamper: (body) => {
      body.reportDataHex = '00'.repeat(64)
      body.quote = Buffer.from('ANTSEED-MOCK-QUOTE\0').toString('base64') // strips bound report_data
    },
  })
  const reg = approvedRegistryFile()
  const regFile = await writeTmpRegistry(reg.set)
  try {
    const outcome = await verifyTeeSeller(
      teePeer(baseUrl),
      baseOpts({ requireTee: true, registryUrl: regFile, pinnedRegistrySigner: reg.set.signer }),
    )
    assert.equal(outcome.isTeeSeller, true)
    assert.notEqual(outcome.result?.verdict, 'verified')
    assert.equal(outcome.allowed, false, 'requireTee refuses a failed seller')
    assert.match(outcome.reason ?? '', /require-tee/)
  } finally {
    server.close()
  }
})

test('substituted enclave key (/pubkey MITM) fails check #3 when --require-tee', async () => {
  // The quote attests the seller's real enclave key, but /pubkey serves a
  // DIFFERENT ed25519 key. The buyer recomputes report_data over the served key,
  // so check #3 (which binds the enclave key) fails — exactly the MITM the fix
  // closes.
  const { server, baseUrl } = await startMockSeller({
    pubkeyTamper: (body) => {
      body.enclavePubkey = 'ee'.repeat(44)
    },
  })
  const reg = approvedRegistryFile()
  const regFile = await writeTmpRegistry(reg.set)
  try {
    const outcome = await verifyTeeSeller(
      teePeer(baseUrl),
      baseOpts({ requireTee: true, registryUrl: regFile, pinnedRegistrySigner: reg.set.signer }),
    )
    assert.equal(outcome.isTeeSeller, true)
    assert.notEqual(outcome.result?.verdict, 'verified')
    assert.equal(outcome.result?.checks.find((c) => c.id === 3)?.status, 'fail')
    assert.equal(outcome.allowed, false)
  } finally {
    server.close()
  }
})

test('peer pubkey that fails authentication is rejected when --require-tee', async () => {
  // The resolver (node accessor) returns null: the served secp256k1 key does not
  // derive to the connected peer's authenticated peerId (a MITM-substituted
  // channel key). Verification aborts before any quote check.
  const { server, baseUrl } = await startMockSeller({})
  const reg = approvedRegistryFile()
  const regFile = await writeTmpRegistry(reg.set)
  try {
    const outcome = await verifyTeeSeller(
      teePeer(baseUrl),
      baseOpts({
        requireTee: true,
        registryUrl: regFile,
        pinnedRegistrySigner: reg.set.signer,
        authenticatePeerPubkey: () => null,
      }),
    )
    assert.equal(outcome.isTeeSeller, true)
    assert.equal(outcome.result, null)
    assert.equal(outcome.allowed, false)
    assert.match(outcome.reason ?? '', /authenticated identity/)
  } finally {
    server.close()
  }
})

test('unapproved measurement fails when --require-tee (empty registry)', async () => {
  const { server, baseUrl } = await startMockSeller({})
  const reg = emptyRegistryFile()
  const regFile = await writeTmpRegistry(reg.set)
  try {
    const outcome = await verifyTeeSeller(
      teePeer(baseUrl),
      baseOpts({ requireTee: true, registryUrl: regFile, pinnedRegistrySigner: reg.set.signer }),
    )
    assert.equal(outcome.result?.verdict, 'failed')
    assert.equal(outcome.allowed, false)
  } finally {
    server.close()
  }
})

test('failed verification is advisory (allowed) when not required', async () => {
  const { server, baseUrl } = await startMockSeller({})
  const reg = emptyRegistryFile() // measurement not approved -> failed verdict
  const regFile = await writeTmpRegistry(reg.set)
  try {
    const outcome = await verifyTeeSeller(
      teePeer(baseUrl),
      baseOpts({ requireTee: false, registryUrl: regFile, pinnedRegistrySigner: reg.set.signer }),
    )
    assert.equal(outcome.result?.verdict, 'failed')
    assert.equal(outcome.allowed, true, 'advisory path still routes')
    assert.match(outcome.reason ?? '', /advisory/)
  } finally {
    server.close()
  }
})

test('non-TEE seller path is unaffected (no fetch, allowed)', async () => {
  assert.equal(isTeeSeller(plainPeer()), false)
  const outcome = await verifyTeeSeller(plainPeer(), baseOpts({ requireTee: true, registryUrl: 'unused' }))
  assert.equal(outcome.isTeeSeller, false)
  assert.equal(outcome.result, null)
  assert.equal(outcome.allowed, true)
})

// --- tmp registry file helper ---
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpDirs: string[] = []
async function writeTmpRegistry(set: ValidSet): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-tee-'))
  tmpDirs.push(dir)
  const file = join(dir, 'validset.json')
  await writeFile(file, JSON.stringify(set))
  return file
}

test.after(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})))
})

test('launcher seller over HTTP: buyer dispatches to the claims verifier and accepts an approved binary', async () => {
  const { server, baseUrl } = await startMockLauncherSeller({})
  const reg = launcherRegistryFile()
  const regFile = await writeTmpRegistry(reg.set)
  try {
    const outcome = await verifyTeeSeller(
      teePeer(baseUrl),
      baseOpts({ requireTee: true, registryUrl: regFile, pinnedRegistrySigner: reg.set.signer }),
    )
    assert.equal(outcome.schema, 'launcher')
    assert.ok(outcome.launcherResult, 'launcherResult present')
    assert.equal(outcome.launcherResult!.verdict, 'verified')
    assert.equal(outcome.allowed, true)
    const byId = (id: string) => outcome.launcherResult!.claims.find((c) => c.claim === id)!
    assert.equal(byId('hardware-genuine').verdict, 'verified')
    assert.equal(byId('approved-binary').verdict, 'verified')
    assert.equal(byId('binary-active').verdict, 'verified')
    assert.equal(byId('approved-launcher').verdict, 'verified')
  } finally {
    server.close()
  }
})

test('launcher seller with an UNAPPROVED binary is refused under --require-tee', async () => {
  const { server, baseUrl } = await startMockLauncherSeller({ binaryDigest: 'dd'.repeat(32) })
  const reg = launcherRegistryFile()
  const regFile = await writeTmpRegistry(reg.set)
  try {
    const outcome = await verifyTeeSeller(
      teePeer(baseUrl),
      baseOpts({ requireTee: true, registryUrl: regFile, pinnedRegistrySigner: reg.set.signer }),
    )
    assert.equal(outcome.schema, 'launcher')
    assert.equal(outcome.launcherResult!.verdict, 'failed')
    assert.equal(outcome.allowed, false)
    assert.ok(outcome.launcherResult!.unmetRequired.includes('approved-binary'))
  } finally {
    server.close()
  }
})
