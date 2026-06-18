/**
 * Attestation platform identifier.
 * - `tdx`     : Intel TDX confidential VM (configfs-tsm / tdx_guest).
 * - `sev-snp` : AMD SEV-SNP confidential VM (/dev/sev-guest).
 * - `mock`    : deterministic, clearly-non-genuine quote for dev/test only.
 */
export type AttestationPlatform = "tdx" | "sev-snp" | "mock";

/**
 * Inputs bound into the quote's `report_data` via the canonical encoder
 * (see {@link ../report-data.ts}). All values are hex strings (no `0x`
 * required; an optional `0x` prefix is tolerated).
 *
 * MVP populates only `peerPubkey` + `nonce`. `bundleDigest` / `configHash` are
 * forward-compat for requirement #4 and the base/bundle measurement split.
 */
export interface ReportDataBindings {
  /** Hex-encoded peer/enclave public key (the same key that identifies the P2P channel). */
  peerPubkey: string;
  /** Hex-encoded buyer-supplied nonce for this verification round (replay defense). */
  nonce: string;
  /** Optional hex-encoded seller-bundle content digest D. Forward-compat. */
  bundleDigest?: string;
  /** Optional hex-encoded effective-config hash. Forward-compat. */
  configHash?: string;
}

/**
 * A hardware (or, for `mock`, simulated) attestation quote.
 *
 * The image MEASUREMENT lives in `measurements` (MRTD/RTMR for TDX, MEASUREMENT
 * for SEV-SNP) and is checked against the approved set. `reportData` separately
 * binds the channel/verification bindings. The two are intentionally distinct
 * concerns and are never conflated.
 */
export interface AttestationQuote {
  platform: AttestationPlatform;
  /** Raw vendor quote/report bytes (opaque; parsed by the platform verifier). */
  quote: Uint8Array;
  /** The 64 bytes the hardware was asked to bind (== packReportData(bindings)). */
  reportData: Uint8Array;
  /**
   * Measurement registers, keyed by register name (e.g. `mrtd`, `rtmr0`..`rtmr3`
   * for TDX; `measurement` for SEV-SNP). Values are hex strings. The verifier's
   * approved-set check operates on the canonical measurement derived from these.
   */
  measurements: Record<string, string>;
  /**
   * Optional verification collateral (DCAP/KDS cert chains, TCB info). Fetched
   * by the verifier against silicon-vendor PKI; not produced locally.
   */
  collateral?: Record<string, string>;
}

/**
 * A source of attestation quotes for one platform. Quote generation is LOCAL
 * ONLY — it talks to kernel interfaces against silicon-vendor roots and makes no
 * network call (only the verifier later fetches collateral).
 */
export interface AttestationProvider {
  readonly platform: AttestationPlatform;
  /** True if this platform's kernel interfaces are present on the host. */
  isAvailable(): Promise<boolean>;
  /** Produce a quote committing to exactly the bindings' packed report_data. */
  generateQuote(bindings: ReportDataBindings): Promise<AttestationQuote>;
}
