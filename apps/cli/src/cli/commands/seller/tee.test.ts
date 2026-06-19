import assert from 'node:assert/strict'
import test from 'node:test'
import { identityFromPrivateKeyHex } from '@antseed/node'
import { packReportData } from '@antseed/tee'
import { buildSellerTeeWiring } from './tee.js'

const PRIV = '11'.repeat(32)

function makeIdentity() {
  return identityFromPrivateKeyHex(PRIV)
}

test('buildSellerTeeWiring (mock platform) advertises /evidence and serves endpoints', async () => {
  const identity = makeIdentity()
  const wiring = await buildSellerTeeWiring(identity, { enabled: true, platform: 'mock' })

  assert.equal(wiring.platform, 'mock')
  assert.equal(wiring.teeAttestationUrl, '/evidence')
  assert.ok(wiring.enclaveSigningPubkey.length > 0)

  const expectedPubkey = identity.wallet.signingKey.compressedPublicKey.replace(/^0x/, '')

  // /pubkey serves BOTH the secp256k1 channel key and the ed25519 enclave key.
  const pubkeyReply = await wiring.handler('/pubkey')
  assert.equal(pubkeyReply?.status, 200)
  assert.deepEqual(pubkeyReply?.body, {
    peerPubkey: expectedPubkey,
    enclavePubkey: wiring.enclaveSigningPubkey,
  })

  // /.well-known descriptor advertises the scheme + platform.
  const wk = await wiring.handler('/.well-known/antseed-evidence')
  assert.equal(wk?.status, 200)
  assert.equal((wk?.body as { scheme: string }).scheme, 'antseed-tee/v1')

  // Unrelated path falls through (null) so /metadata still works.
  assert.equal(await wiring.handler('/metadata'), null)
})

test('evidence bundle binds the buyer nonce to the canonical report_data', async () => {
  const identity = makeIdentity()
  const wiring = await buildSellerTeeWiring(identity, { enabled: true, platform: 'mock' })
  const peerPubkey = identity.wallet.signingKey.compressedPublicKey.replace(/^0x/, '')
  const nonce = 'ab'.repeat(32)

  const reply = await wiring.handler(`/evidence?nonce=${nonce}`)
  assert.equal(reply?.status, 200)
  const body = reply!.body as {
    nonce: string
    reportDataHex: string
    peerPubkey: string
    enclavePubkey: string
  }
  assert.equal(body.nonce, nonce)
  assert.equal(body.peerPubkey, peerPubkey)
  assert.equal(body.enclavePubkey, wiring.enclaveSigningPubkey)

  // report_data in the bundle equals the canonical recompute the buyer performs
  // over BOTH the channel key and the attested ed25519 enclave key.
  const expected = Buffer.from(
    packReportData({ peerPubkey, enclavePubkey: wiring.enclaveSigningPubkey, nonce }),
  ).toString('hex')
  assert.equal(body.reportDataHex, expected)
})

test('rejects autodetected mock when operator did not opt in', async () => {
  const identity = makeIdentity()
  // No platform set + no TDX device on this host → autodetect yields mock,
  // which is refused unless explicitly configured.
  await assert.rejects(
    () => buildSellerTeeWiring(identity, { enabled: true }),
    /mock/i,
  )
})
