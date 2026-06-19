import { generateKeyPairSync } from 'node:crypto'
import {
  resolveSellerAttestation,
  handleEvidenceRequest,
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

  // In-enclave ed25519 signing key (v2 model-call transcript signer). Generated
  // fresh per process so the key lives only inside this enclave instance.
  const { publicKey } = generateKeyPairSync('ed25519')
  const enclaveSigningPubkey = publicKey
    .export({ type: 'spki', format: 'der' })
    .toString('hex')

  // The peer pubkey bound into report_data is the seller's AntSeed identity
  // public key (compressed secp256k1) — the same key that authenticates the P2P
  // channel.
  const peerPubkey = identity.wallet.signingKey.compressedPublicKey.replace(/^0x/, '')

  const ctx: EvidenceContext = {
    attestation: provider,
    peerPubkey,
  }

  const handler = async (url: string): Promise<{ status: number; body: unknown } | null> => {
    const reply = await handleEvidenceRequest(url, ctx)
    return reply ? { status: reply.status, body: reply.body } : null
  }

  return {
    platform,
    teeAttestationUrl: EVIDENCE_PATH,
    enclaveSigningPubkey,
    handler,
  }
}
