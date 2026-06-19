import {
  Quote,
  intel,
  getCollateral,
  getCollateralFromPcs,
  type Collateral,
} from "@phala/dcap-qvl";

/**
 * DCAP collateral acquisition for a TDX quote.
 *
 * A buyer's verifier (`verifier/dcap.ts`) is network-free: it consumes the
 * collateral (Intel PCK cert chain/CRL + TCB info + QE identity) handed to it on
 * `quote.collateral` and makes no outbound call while deciding a verdict. That
 * collateral has to come from somewhere — this module is the single place that
 * fetches it, on the SELLER side, so it can be embedded in the evidence bundle.
 *
 * Source: `@phala/dcap-qvl`'s `getCollateralFromPcs(quote)`, which parses the
 * FMSPC from the quote's PCK cert chain and fetches the matching collateral from
 * Intel's PCS v4 (`https://api.trustedservices.intel.com/{sgx,tdx}/certification/v4/...`
 * — pckcrl, tcb, qe/identity, rootcacrl). A PCCS mirror can be used instead by
 * passing its base URL.
 *
 * Collateral changes infrequently (TCB info / QE identity have multi-week
 * validity windows), so results are cached in-process keyed by FMSPC.
 */

/**
 * The protocol's wire shape for collateral: a flat `Record<string, string>` that
 * serializes cleanly into the evidence bundle JSON and feeds the verifier's
 * `toLibCollateral` adapter. The library returns CRL/signature fields as
 * `number[]`; we hex-encode those so every value is a string.
 */
export type WireCollateral = Record<string, string>;

const REQUIRED_FIELDS = [
  "pck_crl_issuer_chain",
  "root_ca_crl",
  "pck_crl",
  "tcb_info_issuer_chain",
  "tcb_info",
  "tcb_info_signature",
  "qe_identity_issuer_chain",
  "qe_identity",
  "qe_identity_signature",
] as const;

/** Fields the library returns as either a hex string or a raw byte array. */
const BYTE_FIELDS = new Set<string>([
  "root_ca_crl",
  "pck_crl",
  "tcb_info_signature",
  "qe_identity_signature",
]);

/** Process-wide cache: FMSPC (hex) -> normalized collateral. */
const cache = new Map<string, WireCollateral>();

/**
 * Normalize a library `Collateral` into the flat all-strings wire shape. Byte
 * fields (`number[]` | `string`) become hex strings; PEM/JSON string fields pass
 * through. The library's extra `pck_certificate_chain` is preserved when present
 * (it is harmless to the verifier, which only reads the required fields).
 */
export function normalizeCollateral(c: Collateral): WireCollateral {
  const out: WireCollateral = {};
  for (const [key, value] of Object.entries(c as unknown as Record<string, unknown>)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      out[key] = Buffer.from(value as number[]).toString("hex");
    } else if (BYTE_FIELDS.has(key) && typeof value !== "string") {
      out[key] = Buffer.from(value as Uint8Array).toString("hex");
    } else {
      out[key] = String(value);
    }
  }
  for (const k of REQUIRED_FIELDS) {
    if (out[k] === undefined) {
      throw new Error(`fetched DCAP collateral is missing required field '${k}'`);
    }
  }
  return out;
}

/** FMSPC (hex) parsed from the quote's PCK cert — the cache key. */
function fmspcOf(quote: Uint8Array): string {
  const parsed = Quote.parse(Buffer.from(quote));
  return Buffer.from(intel.getFmspc(parsed)).toString("hex").toLowerCase();
}

/**
 * Fetch (and cache) DCAP collateral for a TDX quote. Lazy + cached by FMSPC:
 * many quotes from the same platform share collateral, and it rarely changes.
 *
 * @param quote   raw DCAP quote bytes.
 * @param pccsUrl optional PCCS/PCS base URL. Defaults to Intel PCS.
 */
export async function fetchTdxCollateral(
  quote: Uint8Array,
  pccsUrl?: string,
): Promise<WireCollateral> {
  let key: string;
  try {
    key = fmspcOf(quote);
  } catch {
    key = ""; // unparseable FMSPC: skip cache, let the fetch surface the error
  }
  if (key && cache.has(key)) return cache.get(key)!;

  const raw = Buffer.from(quote);
  const libCollateral = pccsUrl
    ? await getCollateral(pccsUrl, raw)
    : await getCollateralFromPcs(raw);
  const normalized = normalizeCollateral(libCollateral);

  if (key) cache.set(key, normalized);
  return normalized;
}

/** Clear the in-process collateral cache (tests). */
export function clearCollateralCache(): void {
  cache.clear();
}
