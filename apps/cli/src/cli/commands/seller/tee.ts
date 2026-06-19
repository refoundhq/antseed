import { generateKeyPairSync } from 'node:crypto'
import {
  resolveSellerAttestation,
  createEvidenceHandler,
  assertProductionPlatform,
  type EvidenceContext,
} from '@antseed/tee'
import type { Identity } from '@antseed/node'
import type { TeeSellerConfig } from '../../../config/types.js'

/** Default relative evidence path served on the signaling-port HTTP server. */
const EVIDENCE_PATH = '/evidence'

export interface SellerTeeWiring {
  /** Selected attestation platform (tdx / sev-snp / mock). */
  platform: string
  /** Value advertised in peer metadata (relative path resolved against the peer endpoint). */
  teeAttestationUrl: string
  /** Hex of the in-enclave ed25519 signing public key (v2 transcript signer). */
  enclaveSigningPubkey: string
  /** Async handler for the connection-manager evidence endpoints. */
  handler: (url: string) => Promise<{ status: number; body: unknown } | null>
}

/**
 * Build the seller-side TEE wiring: pick the attestation platform, derive an
 * in-enclave ed25519 signing key, and produce an evidence handler bound to the
 * seller's AntSeed peer pubkey. The handler serves `/evidence?nonce=`,
 * `/.well-known/antseed-evidence`, and `/pubkey`; the fresh nonce is supplied
 * per request by the buyer (replay defense) and echoed back verbatim so the
 * buyer can recompute and verify the bound report_data.
 *
 * Production safety: refuses to advertise a `mock` platform unless the operator
 * explicitly configured `platform: 'mock'`.
 */
export async function buildSellerTeeWiring(
  identity: Identity,
  teeConfig: TeeSellerConfig,
): Promise<SellerTeeWiring> {
  const { platform, provider } = await resolveSellerAttestation(teeConfig)

  if (platform === 'mock' && teeConfig.platform !== 'mock') {
    // Autodetect fell back to mock (no TDX device) but the operator did not opt
    // in to mock — fail loudly rather than silently advertising a fake quote.
    assertProductionPlatform(platform)
  }

  // In-enclave ed25519 evidence-signing key. Generated fresh per process so the
  // key lives only inside this enclave instance. It is bound into report_data
  // (below) so the buyer can trust the /pubkey value — otherwise it would be an
  // unattested, MITM-substitutable key.
  const { publicKey } = generateKeyPairSync('ed25519')
  const enclaveSigningPubkey = publicKey
    .export({ type: 'spki', format: 'der' })
    .toString('hex')

  // report_data binds BOTH keys: the seller's AntSeed identity public key
  // (compressed secp256k1, authenticates the P2P channel) AND the ed25519
  // evidence-signing key above.
  const peerPubkey = identity.wallet.signingKey.compressedPublicKey.replace(/^0x/, '')

  const ctx: EvidenceContext = {
    attestation: provider,
    peerPubkey,
    enclavePubkey: enclaveSigningPubkey,
  }

  // Startup self-test: generate one real quote NOW so a seller that advertises a
  // platform it cannot actually attest fails fast at boot, instead of looking
  // healthy and only erroring when the first buyer requests evidence. The probe
  // nonce is fixed (not buyer-supplied) and the bundle is discarded.
  try {
    const probe = await provider.generateQuote({
      peerPubkey,
      enclavePubkey: enclaveSigningPubkey,
      nonce: '00'.repeat(32),
    })
    if (!probe.quote || probe.quote.length === 0) {
      throw new Error('attestation provider returned an empty quote')
    }
  } catch (err) {
    throw new Error(
      `TEE startup self-test failed for platform '${platform}': ${(err as Error).message}. ` +
        'Refusing to advertise a TEE seller that cannot produce a valid quote.',
    )
  }

  // The evidence endpoint is public + unauthenticated and each /evidence request
  // triggers a real quote generation, so serve it through the hardened handler
  // (rate limit + bounded quote concurrency + short per-nonce response cache).
  const evidence = createEvidenceHandler(ctx)
  const handler = async (url: string): Promise<{ status: number; body: unknown } | null> => {
    const reply = await evidence(url)
    return reply ? { status: reply.status, body: reply.body } : null
  }

  return {
    platform,
    teeAttestationUrl: EVIDENCE_PATH,
    enclaveSigningPubkey,
    handler,
  }
}
