import { generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  resolveSellerAttestation,
  createEvidenceHandler,
  createLauncherEvidenceHandler,
  assertProductionPlatform,
  type EvidenceContext,
  type LauncherEvidenceContext,
  type ClaimId,
  type RtmrEvent,
  type ImaEntry,
  type NetworkPolicy,
  type StoragePolicy,
} from '@antseed/tee'
import type { Identity } from '@antseed/node'
import type { TeeSellerConfig } from '../../../config/types.js'

/** Default relative evidence path served on the signaling-port HTTP server. */
const EVIDENCE_PATH = '/evidence'

export interface SellerTeeWiring {
  /** Selected attestation platform (tdx / sev-snp / mock). */
  platform: string
  /** Evidence schema being served (`v1` legacy bundle or `launcher`). */
  schema: 'v1' | 'launcher'
  /** Value advertised in peer metadata (relative path resolved against the peer endpoint). */
  teeAttestationUrl: string
  /** Hex of the in-enclave ed25519 evidence-signing public key (bound into report_data). */
  enclaveSigningPubkey: string
  /** Hex of the in-enclave X25519 channel key the buyer e2ee's to (launcher mode). */
  channelPubkey?: string
  /** Claims attested in launcher mode (empty in v1). */
  claims: ClaimId[]
  /** Async handler for the connection-manager evidence endpoints. */
  handler: (url: string) => Promise<{ status: number; body: unknown } | null>
}

/** Raw 32-byte public key (hex) from an X25519 KeyObject. */
function rawX25519Hex(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  return Buffer.from(
    (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32),
  ).toString('hex')
}

/**
 * The AntSeed seller binary identity this process attests. Provided by the build /
 * deploy step (the launcher that execs the seller computes the digest) via env —
 * this is the "locked binary versions" injection and needs NO locked VM image.
 */
function binaryFromEnv(): { digest: string; version: string; tag: string } | undefined {
  const digest = process.env.ANTSEED_BINARY_DIGEST?.trim()
  if (!digest) return undefined
  return {
    digest,
    version: process.env.ANTSEED_BINARY_VERSION?.trim() || '0.0.0',
    tag: process.env.ANTSEED_BINARY_TAG?.trim() || 'stable',
  }
}

/**
 * Measured runtime evidence written by the launcher (it applies the egress / storage
 * policy, drops the matching capability, extends the TDX RTMR, and records the logs).
 * The seller reads it from `ANTSEED_MEASURED_EVIDENCE_FILE` and attests the MEASURED
 * claims (egress-allowlisted / no-buyer-data-at-rest / known-binaries-only). Absent
 * file ⇒ those claims are simply not attested.
 */
interface MeasuredEvidence {
  rtmrLog?: RtmrEvent[]
  imaLog?: ImaEntry[]
  imaRtmrIndex?: number
  networkPolicy?: NetworkPolicy
  storagePolicy?: StoragePolicy
}

function readMeasuredEvidence(): MeasuredEvidence | undefined {
  const path = process.env.ANTSEED_MEASURED_EVIDENCE_FILE?.trim()
  if (!path) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as MeasuredEvidence
  } catch {
    return undefined
  }
}

/**
 * Build the seller-side TEE wiring: pick the attestation platform, derive the
 * in-enclave keys, and produce an evidence handler bound to the seller's AntSeed
 * peer pubkey. The handler serves `/evidence?nonce=`, `/.well-known/antseed-evidence`,
 * and `/pubkey`.
 *
 * Two schemas:
 * - `launcher` (when `ANTSEED_TEE_SCHEMA=launcher` or `ANTSEED_BINARY_DIGEST` is set):
 *   serves the enclave-signed launcher evidence document with the à-la-carte claims
 *   this process can attest (hardware-genuine, channel-key-bound, approved-launcher,
 *   and — when the build supplies a binary digest — approved-binary + binary-active).
 * - `v1` (default): the legacy evidence bundle.
 *
 * Production safety: refuses to advertise a `mock` platform unless explicitly
 * configured, and runs a startup quote self-test (fail-fast if it cannot attest).
 */
export async function buildSellerTeeWiring(
  identity: Identity,
  teeConfig: TeeSellerConfig,
): Promise<SellerTeeWiring> {
  const { platform, provider } = await resolveSellerAttestation(teeConfig)

  if (platform === 'mock' && teeConfig.platform !== 'mock') {
    // Autodetect fell back to mock (no TDX device) but the operator did not opt in
    // to mock — fail loudly rather than silently advertising a fake quote.
    assertProductionPlatform(platform)
  }

  // In-enclave ed25519 evidence-signing key. Generated fresh per process so the
  // private half lives only inside this enclave instance; it is bound into
  // report_data and SIGNS the launcher evidence document.
  const { publicKey: edPub, privateKey: enclavePrivateKey } = generateKeyPairSync('ed25519')
  const enclaveSigningPubkey = edPub.export({ type: 'spki', format: 'der' }).toString('hex')

  // In-enclave X25519 channel key. The private half never leaves the process; its
  // public fingerprint is bound into the (enclave-signed) evidence so a buyer can
  // e2ee its payloads to a key only this in-TEE process holds.
  const { publicKey: chPub } = generateKeyPairSync('x25519')
  const channelPubkey = rawX25519Hex(chPub)

  // report_data binds the secp256k1 AntSeed identity key (channel auth) + the
  // ed25519 evidence key.
  const peerPubkey = identity.wallet.signingKey.compressedPublicKey.replace(/^0x/, '')

  // Startup self-test: generate one real quote NOW so a seller that advertises a
  // platform it cannot actually attest fails fast at boot, instead of erroring only
  // when the first buyer requests evidence.
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

  const binary = binaryFromEnv()
  const launcherMode = process.env.ANTSEED_TEE_SCHEMA?.trim() === 'launcher' || Boolean(binary)

  if (!launcherMode) {
    // v1 legacy bundle.
    const ctx: EvidenceContext = { attestation: provider, peerPubkey, enclavePubkey: enclaveSigningPubkey }
    const evidence = createEvidenceHandler(ctx)
    return {
      platform,
      schema: 'v1',
      teeAttestationUrl: EVIDENCE_PATH,
      enclaveSigningPubkey,
      claims: [],
      handler: async (url) => {
        const r = await evidence(url)
        return r ? { status: r.status, body: r.body } : null
      },
    }
  }

  // Launcher mode: attest the claims this process can actually back.
  const claims: ClaimId[] = ['hardware-genuine', 'channel-key-bound', 'approved-launcher']
  if (binary) claims.push('approved-binary', 'binary-active')

  // Measured specific attestations: attested iff the launcher recorded them (it
  // applies the policy, drops the matching capability, and extends the RTMR).
  const measured = readMeasuredEvidence()
  if (measured?.rtmrLog && measured.networkPolicy) claims.push('egress-allowlisted')
  if (measured?.rtmrLog && measured.storagePolicy) claims.push('no-buyer-data-at-rest')
  if (measured?.imaLog && measured.imaLog.length > 0) claims.push('known-binaries-only')

  const launcherCtx: Omit<LauncherEvidenceContext, 'timestamp'> = {
    platform: provider.platform,
    attestation: provider,
    claims,
    peerPubkey,
    enclavePubkey: enclaveSigningPubkey,
    enclavePrivateKey,
    channelPubkey,
    ...(process.env.ANTSEED_LAUNCHER_VERSION?.trim()
      ? { launcherVersion: process.env.ANTSEED_LAUNCHER_VERSION.trim() }
      : {}),
    ...(binary ? { antseedBinary: binary } : {}),
    ...(measured?.rtmrLog ? { rtmrLog: measured.rtmrLog } : {}),
    ...(measured?.imaLog ? { imaLog: measured.imaLog } : {}),
    ...(measured?.imaRtmrIndex !== undefined ? { imaRtmrIndex: measured.imaRtmrIndex } : {}),
    ...(measured?.networkPolicy ? { networkPolicy: measured.networkPolicy } : {}),
    ...(measured?.storagePolicy ? { storagePolicy: measured.storagePolicy } : {}),
  }
  const evidence = createLauncherEvidenceHandler(launcherCtx)

  return {
    platform,
    schema: 'launcher',
    teeAttestationUrl: EVIDENCE_PATH,
    enclaveSigningPubkey,
    channelPubkey,
    claims,
    handler: async (url) => {
      const r = await evidence(url)
      return r ? { status: r.status, body: r.body } : null
    },
  }
}
