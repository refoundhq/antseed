import { randomBytes } from 'node:crypto'
import type { PeerInfo } from '@antseed/node'
import {
  verifySeller,
  defaultProductionPolicy,
  type VerifySellerResult,
  type VerificationPolicy,
  type TcbPolicy,
} from '@antseed/tee/verifier'
import { RegistryClient } from '@antseed/tee/registry'
import type { AttestationPlatform, AttestationQuote } from '@antseed/tee/attestation'
import {
  verifyLauncherEvidence,
  EVIDENCE_SCHEMA_LAUNCHER,
  type LauncherVerifyResult,
  type EvidenceDocument,
  type ClaimId,
} from '@antseed/tee'
import { log } from './request-utils.js'

/**
 * Default approved-set registry source. Buyers can override via
 * `buyer.teeRegistryUrl` (URL or local file path). The fallback points at the
 * AntSeed well-known governance endpoint so `--require-tee` works out of the box
 * without extra config.
 */
export const DEFAULT_TEE_REGISTRY_URL = 'https://antseed.network/.well-known/antseed-tee-validset.json'

export interface TeeVerifyOptions {
  /** Refuse to route to a TEE-tagged seller unless it verifies. */
  requireTee: boolean
  /** Registry source (URL or local JSON file). Defaults to DEFAULT_TEE_REGISTRY_URL. */
  registryUrl?: string
  /** Pinned governance signer (hex ed25519 pubkey). Loads must match it when set. */
  pinnedRegistrySigner?: string
  /**
   * Dev-only escape hatch: permit verification WITHOUT a pinned registry signer.
   * Production posture requires a pinned signer whenever `requireTee`; without
   * this flag, a missing pin under `requireTee` fails closed.
   */
  allowUnpinnedSigner?: boolean
  /** Allowed attestation platforms. PRODUCTION DEFAULT: ['tdx']. */
  platforms?: AttestationPlatform[]
  /**
   * TCB posture: 'uptodate-only' (strict) or 'allow-swhardening' (default —
   * UpToDate passes, SW-hardening/configuration states pass with a warning).
   */
  tcbPolicy?: TcbPolicy
  /** Minimum acceptable registry ValidSet version (rollback floor). */
  registryMinVersion?: number
  /** Minimum acceptable registry revocationEpoch. */
  registryMinRevocationEpoch?: number
  /** Allow the dev/test `mock` platform to reach a verified verdict. Default false. */
  allowMock?: boolean
  /**
   * Launcher schema: the claims the buyer REQUIRES verified to route. Defaults to
   * `['hardware-genuine','approved-binary','binary-active']` under `requireTee`
   * (the locked-binary-versions posture), `[]` otherwise. Ignored for v1 evidence.
   */
  requiredClaims?: ClaimId[]
  /** Pinned AntSeed release key (hex ed25519); requires a valid release sig on approved-binary. */
  pinnedReleaseSigner?: string
  /** Allowed binary release tags (e.g. ['stable']). */
  allowedBinaryTags?: string[]
  /** Per-fetch timeout (ms). Default 4000. */
  fetchTimeoutMs?: number
  /**
   * Authenticate a candidate secp256k1 peer pubkey against the connected peer's
   * authenticated peerId. Supplied by the buyer-proxy from the node accessor
   * (`getAuthenticatedConnectedPeerPublicKey`). Returns the normalized pubkey if
   * it derives to the peer's authenticated identity, else null. When omitted,
   * verification cannot anchor the channel identity and fails closed.
   */
  authenticatePeerPubkey?: (peerId: string, candidatePubkeyHex: string) => string | null
}

export interface TeeVerificationOutcome {
  /** True when this peer advertises TEE attestation (tag `tee` or teeAttestationUrl). */
  isTeeSeller: boolean
  /** Which evidence schema was served/verified. */
  schema: 'v1' | 'launcher'
  /** v1 verifier result, when the v1 path ran. Null otherwise. */
  result: VerifySellerResult | null
  /** Launcher claims result, when the launcher path ran. Null otherwise. */
  launcherResult: LauncherVerifyResult | null
  /** Whether routing should be allowed. False only when requireTee and verification failed. */
  allowed: boolean
  /** Human-readable reason when `allowed` is false (or a fetch/verify error). */
  reason: string | null
}

/** Discovery descriptor served at /.well-known/antseed-evidence. */
interface EvidenceDescriptor {
  scheme: string
  platform: string
  evidencePath: string
  pubkeyPath: string
}

/** Evidence bundle returned by GET <evidencePath>?nonce=<hex>. */
interface EvidenceBundle {
  scheme: string
  platform: string
  peerPubkey: string
  enclavePubkey: string
  nonce: string
  quote: string
  reportDataHex: string
  measurements: Record<string, string>
  /** Optional seller-bundle digest D (two-tier deployments); a policy input. */
  bundleDigest?: string
  /** Optional effective-config hash; a policy input. */
  configHash?: string
  /** DCAP collateral the seller embedded; consumed by the verifier (no Intel call here). */
  collateral?: Record<string, string>
  timestamp: number
}

const WELLKNOWN_PATH = '/.well-known/antseed-evidence'
const PUBKEY_PATH = '/pubkey'

/**
 * Detect whether a peer advertises TEE attestation. A peer is treated as a TEE
 * seller if any announced provider carries a `teeAttestationUrl`, or if any
 * service is tagged with the well-known `tee` category.
 */
export function isTeeSeller(peer: PeerInfo): boolean {
  return resolveTeeAttestationUrl(peer) !== null || hasTeeCategory(peer)
}

function hasTeeCategory(peer: PeerInfo): boolean {
  const matrix = peer.providerServiceCategories
  if (matrix) {
    for (const entry of Object.values(matrix)) {
      for (const cats of Object.values(entry.services ?? {})) {
        if (cats.some((c) => c.toLowerCase() === 'tee')) return true
      }
    }
  }
  for (const provider of peer.metadata?.providers ?? []) {
    for (const cats of Object.values(provider.serviceCategories ?? {})) {
      if (cats.some((c) => c.toLowerCase() === 'tee')) return true
    }
  }
  return false
}

/**
 * The announced TEE evidence URL, if any. Prefers an explicit
 * `teeAttestationUrl` from any provider announcement; returns null otherwise.
 */
export function resolveTeeAttestationUrl(peer: PeerInfo): string | null {
  for (const provider of peer.metadata?.providers ?? []) {
    const url = provider.teeAttestationUrl?.trim()
    if (url) return url
  }
  return null
}

/**
 * Resolve the seller's evidence HTTP base URL (`http://host:port`) from its
 * `publicAddress`. The evidence routes are served on the same signaling-port
 * HTTP server that answers `/metadata`, so the base is identical to discovery.
 */
export function resolveEvidenceBaseUrl(peer: PeerInfo): string | null {
  const addr = peer.publicAddress?.trim()
  if (!addr) return null
  // Same host:port the metadata resolver fetches /metadata from — the evidence
  // routes are served on the seller's signaling-port HTTP server.
  const lastColon = addr.lastIndexOf(':')
  if (lastColon <= 0 || lastColon === addr.length - 1) return null
  const host = addr.slice(0, lastColon).trim()
  const portText = addr.slice(lastColon + 1)
  if (host.length === 0 || !/^\d+$/.test(portText)) return null
  const port = Number(portText)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return `http://${host}:${port}`
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Reconstruct the `AttestationQuote` the verifier expects from the on-the-wire
 * evidence bundle. The bundle carries the quote as base64 and the measurement
 * registers as hex; the verifier re-derives report_data itself, so we only need
 * the raw quote bytes + measurements + platform.
 */
function quoteFromBundle(bundle: EvidenceBundle): AttestationQuote {
  return {
    platform: bundle.platform as AttestationPlatform,
    quote: new Uint8Array(Buffer.from(bundle.quote, 'base64')),
    reportData: new Uint8Array(Buffer.from(bundle.reportDataHex, 'hex')),
    measurements: bundle.measurements,
    // DCAP collateral travels in the bundle so the verifier checks TCB status
    // offline — no Intel-PCS dependency at buyer verify time.
    ...(bundle.collateral ? { collateral: bundle.collateral } : {}),
  }
}

/**
 * Run buyer-side TEE verification for one selected seller.
 *
 * Nonce: a fresh 32-byte hex value generated here and supplied in the
 * `/evidence?nonce=` query. The verifier re-derives report_data over this exact
 * nonce (check #3), so a replayed/stale quote fails.
 *
 * Two keys are bound into report_data and re-derived by the verifier:
 *
 *  - connectedPeerPubkey (secp256k1): the seller's channel-identity key. It is
 *    served at `/pubkey`, but we do NOT trust the served value blindly — we run
 *    it through `opts.authenticatePeerPubkey`, which confirms it derives to the
 *    connected peer's authenticated `peerId` (the node's
 *    `getAuthenticatedConnectedPeerPublicKey`). A MITM-substituted key fails
 *    derivation and verification aborts.
 *  - enclavePubkey (ed25519): the in-enclave evidence-signing key, also served
 *    at `/pubkey`. It is trusted ONLY because it is bound into report_data: if
 *    the seller served a different key than the enclave attested, check #3 fails.
 */
export async function verifyTeeSeller(
  peer: PeerInfo,
  opts: TeeVerifyOptions,
): Promise<TeeVerificationOutcome> {
  if (!isTeeSeller(peer)) {
    return { isTeeSeller: false, schema: 'v1', result: null, launcherResult: null, allowed: true, reason: null }
  }

  const fetchTimeoutMs = opts.fetchTimeoutMs ?? 4000
  const fail = (reason: string): TeeVerificationOutcome => {
    log(`TEE verify ${peer.peerId.slice(0, 12)}...: ${reason}`)
    return {
      isTeeSeller: true,
      schema: 'v1',
      result: null,
      launcherResult: null,
      allowed: !opts.requireTee,
      reason,
    }
  }

  const baseUrl = resolveEvidenceBaseUrl(peer)
  if (!baseUrl) {
    return fail('no reachable publicAddress to fetch TEE evidence from')
  }

  // 1. Discover evidence + pubkey paths.
  let descriptor: EvidenceDescriptor
  try {
    descriptor = await fetchJson<EvidenceDescriptor>(baseUrl + WELLKNOWN_PATH, fetchTimeoutMs)
  } catch (err) {
    return fail(`failed to fetch ${WELLKNOWN_PATH}: ${errText(err)}`)
  }
  const evidencePath = typeof descriptor.evidencePath === 'string' ? descriptor.evidencePath : '/evidence'
  const pubkeyPath = typeof descriptor.pubkeyPath === 'string' ? descriptor.pubkeyPath : PUBKEY_PATH

  // 2. Fetch the seller's two keys, then AUTHENTICATE the secp256k1 channel key
  //    against the connected peer's authenticated identity (peerId). The ed25519
  //    enclave key is taken as-is here — it is attested via report_data (check #3).
  let connectedPeerPubkey: string
  let enclavePubkey: string
  try {
    const body = await fetchJson<{ peerPubkey?: string; enclavePubkey?: string }>(
      baseUrl + pubkeyPath,
      fetchTimeoutMs,
    )
    if (!body.peerPubkey || typeof body.peerPubkey !== 'string') {
      return fail(`${pubkeyPath} did not return a peerPubkey`)
    }
    if (!body.enclavePubkey || typeof body.enclavePubkey !== 'string') {
      return fail(`${pubkeyPath} did not return an enclavePubkey`)
    }
    if (!opts.authenticatePeerPubkey) {
      return fail('no authenticatePeerPubkey resolver available — cannot anchor channel identity')
    }
    const authenticated = opts.authenticatePeerPubkey(peer.peerId, body.peerPubkey)
    if (!authenticated) {
      return fail(`${pubkeyPath} peerPubkey does not derive to the connected peer's authenticated identity`)
    }
    connectedPeerPubkey = authenticated
    enclavePubkey = body.enclavePubkey
  } catch (err) {
    return fail(`failed to fetch ${pubkeyPath}: ${errText(err)}`)
  }

  // 3. Generate a fresh nonce and request bound evidence (schema-agnostic fetch).
  const nonce = randomBytes(32).toString('hex')
  const evidenceUrl = `${baseUrl}${evidencePath}?nonce=${nonce}`
  let raw: Record<string, unknown>
  try {
    raw = await fetchJson<Record<string, unknown>>(evidenceUrl, fetchTimeoutMs)
  } catch (err) {
    return fail(`failed to fetch evidence: ${errText(err)}`)
  }
  const schema: 'v1' | 'launcher' = raw.schema === EVIDENCE_SCHEMA_LAUNCHER ? 'launcher' : 'v1'

  // 4. Production posture: a pinned registry signer is MANDATORY under --require-tee.
  if (opts.requireTee && !opts.pinnedRegistrySigner && !opts.allowUnpinnedSigner) {
    return fail(
      'a pinned registry signer (--tee-registry-signer) is REQUIRED under --require-tee; ' +
        'pass --tee-allow-unpinned to override (dev only)',
    )
  }

  // 5. Load the approved-set registry (fail-closed inside RegistryClient).
  const registry = new RegistryClient({
    ...(opts.pinnedRegistrySigner ? { pinnedSigner: opts.pinnedRegistrySigner } : {}),
    ...(opts.allowUnpinnedSigner ? { allowUnpinnedSigner: true } : {}),
    policy: {
      ...(opts.registryMinVersion !== undefined ? { minVersion: opts.registryMinVersion } : {}),
      ...(opts.registryMinRevocationEpoch !== undefined
        ? { minRevocationEpoch: opts.registryMinRevocationEpoch }
        : {}),
    },
  })
  try {
    await registry.load(opts.registryUrl ?? DEFAULT_TEE_REGISTRY_URL)
  } catch (err) {
    return fail(`failed to load TEE approved-set registry: ${errText(err)}`)
  }

  // 6. Registry governance fields shared by both schemas. The registry's active
  //    approved measurements (image freedom) become the policy measurementSet.
  const registryPolicy = {
    requireSignerPin: !opts.allowUnpinnedSigner,
    ...(opts.registryMinVersion !== undefined ? { minVersion: opts.registryMinVersion } : {}),
    ...(opts.registryMinRevocationEpoch !== undefined ? { revocationEpoch: opts.registryMinRevocationEpoch } : {}),
  }

  // 7. Dispatch on the served evidence schema (the package verifiers — never reimplemented here).
  if (schema === 'launcher') {
    const policy: VerificationPolicy = defaultProductionPolicy({
      ...(opts.platforms ? { platforms: opts.platforms } : {}),
      ...(opts.tcbPolicy ? { tcbPolicy: opts.tcbPolicy } : {}),
      allowMock: opts.allowMock ?? false,
      measurementSet: registry.approvedMeasurements(),
      requiredClaims:
        opts.requiredClaims ??
        (opts.requireTee ? (['hardware-genuine', 'approved-binary', 'binary-active'] as ClaimId[]) : []),
      ...(opts.pinnedReleaseSigner ? { pinnedReleaseSigner: opts.pinnedReleaseSigner } : {}),
      ...(opts.allowedBinaryTags ? { allowedBinaryTags: opts.allowedBinaryTags } : {}),
      registry: registryPolicy,
    })
    const launcherResult = verifyLauncherEvidence({
      evidence: raw as unknown as EvidenceDocument,
      connectedPeerPubkey,
      nonce,
      registry,
      policy,
    })
    const verified = launcherResult.verdict === 'verified'
    return {
      isTeeSeller: true,
      schema: 'launcher',
      result: null,
      launcherResult,
      allowed: verified || !opts.requireTee,
      reason: verified
        ? null
        : opts.requireTee
          ? `TEE launcher verification failed (unmet required claims: ${launcherResult.unmetRequired.join(', ') || 'binding substrate'}); --require-tee refuses this seller`
          : 'TEE launcher verification failed; advisory only',
    }
  }

  // v1 legacy bundle path.
  const bundle = raw as unknown as EvidenceBundle
  const policy: VerificationPolicy = defaultProductionPolicy({
    ...(opts.platforms ? { platforms: opts.platforms } : {}),
    ...(opts.tcbPolicy ? { tcbPolicy: opts.tcbPolicy } : {}),
    allowMock: opts.allowMock ?? false,
    measurementSet: registry.approvedMeasurements(),
    registry: registryPolicy,
  })
  const result = verifySeller({
    quote: quoteFromBundle(bundle),
    connectedPeerPubkey,
    enclavePubkey,
    nonce,
    registry,
    policy,
    ...(bundle.bundleDigest ? { bundleDigest: bundle.bundleDigest } : {}),
    ...(bundle.configHash ? { configHash: bundle.configHash } : {}),
  })
  const verified = result.verdict === 'verified'
  return {
    isTeeSeller: true,
    schema: 'v1',
    result,
    launcherResult: null,
    allowed: verified || !opts.requireTee,
    reason: verified
      ? null
      : opts.requireTee
        ? `TEE verification failed (verdict=${result.verdict}); --require-tee refuses this seller`
        : `TEE verification failed (verdict=${result.verdict}); advisory only`,
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Render the numbered tri-state checklist + the honesty (notProven) block for
 * stdout/logs. Concise, one line per check.
 */
export function formatVerification(peerId: string, result: VerifySellerResult): string {
  const lines: string[] = []
  lines.push(`TEE verification for ${peerId.slice(0, 12)}... → ${result.verdict.toUpperCase()}`)
  for (const c of result.checks) {
    const mark = c.status === 'pass' ? '✓' : c.status === 'warn' ? '!' : '✗'
    lines.push(`  ${mark} [${c.id}] ${c.title}: ${c.detail}`)
  }
  lines.push('  notProven (MVP scope — these properties are NOT proven):')
  for (const np of result.notProven) {
    lines.push(`    - ${np}`)
  }
  return lines.join('\n')
}

/**
 * Render the per-claim launcher verification report for stdout/logs: the binding
 * substrate, then every claim with its claimed/verdict status, then the honest
 * notProven block. This is the "clarity" the à-la-carte model promises a buyer.
 */
export function formatLauncherVerification(peerId: string, result: LauncherVerifyResult): string {
  const lines: string[] = []
  lines.push(`TEE launcher verification for ${peerId.slice(0, 12)}... → ${result.verdict.toUpperCase()}`)
  lines.push(`  substrate: ${result.substrate.ok ? '✓' : '✗'} ${result.substrate.detail}`)
  for (const c of result.claims) {
    const mark =
      c.verdict === 'verified' ? '✓' : c.verdict === 'not-claimed' ? '·' : c.verdict === 'not-proven' ? '?' : '✗'
    lines.push(`  ${mark} ${c.claim}: ${c.verdict} — ${c.detail}`)
  }
  if (result.unmetRequired.length) lines.push(`  unmet required claims: ${result.unmetRequired.join(', ')}`)
  lines.push('  notProven:')
  for (const np of result.notProven) lines.push(`    - ${np}`)
  return lines.join('\n')
}
