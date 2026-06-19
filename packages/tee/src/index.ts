/**
 * @antseed/tee — confidential-broker attestation for AntSeed TEE sellers.
 *
 * MVP scope: requirement #1 only — "the seller runs only approved code (any
 * approved version)". Built to extend to #2 (operator-blind), #3
 * (no-other-processes), and #4 (model-call transcript) with no rework.
 *
 * Exports are split into a seller half (attestation + evidence) and a buyer half
 * (verifier + registry); subpath exports (`./attestation`, `./evidence`,
 * `./verifier`, `./registry`) keep a pure buyer off the sysfs code paths.
 */

// ---- shared (load-bearing canonical encoder) ----
export {
  packReportData,
  recomputeReportData,
  reportDataEquals,
  REPORT_DATA_CTX,
  REPORT_DATA_LENGTH,
} from "./report-data.js";

// ---- config ----
export type { TeeSellerConfig } from "./config.js";
export { resolveSellerAttestation } from "./config.js";

// ================= SELLER HALF =================
export type {
  AttestationPlatform,
  AttestationProvider,
  AttestationQuote,
  ReportDataBindings,
} from "./attestation/types.js";
export {
  createAttestationProvider,
  MockAttestation,
  MOCK_MEASUREMENTS,
  MOCK_MEASUREMENT,
  assertProductionPlatform,
  TdxAttestation,
  parseTdxMeasurements,
  fetchTdxCollateral,
  normalizeCollateral,
  clearCollateralCache,
} from "./attestation/index.js";
export type { TdxAttestationOptions, WireCollateral } from "./attestation/index.js";

export {
  handleEvidenceRequest,
} from "./evidence/routes.js";
export type {
  EvidenceContext,
  EvidenceBundle,
  EvidenceDescriptor,
  EvidenceReply,
} from "./evidence/routes.js";

// v2 (interface only) — model-call transcript decorator.
// `TeeAttestingProvider` is a type-only `declare class` (no runtime body yet),
// so it MUST be re-exported as a type — a value re-export resolves to nothing at
// runtime and breaks any ESM consumer that imports the package root.
export type { TeeAttestingProvider, EnclaveSigner } from "./attesting-provider.js";

// ================= BUYER HALF =================
export {
  RegistryClient,
  verifyValidSetSignature,
  canonicalizeSignedPayload,
} from "./registry/client.js";
export type { RegistryLoadPolicy } from "./registry/client.js";
export {
  generateRegistryKeypair,
  loadRegistrySigner,
  signValidSetWithPrivateKey,
} from "./registry/sign.js";
export type { RegistryKeypair } from "./registry/sign.js";
export type {
  ValidSet,
  ValidSetEntry,
  ValidSetSignedPayload,
  EntryTcbPolicy,
} from "./registry/types.js";

export { verifySeller, NOT_PROVEN, defaultProductionPolicy } from "./verifier/verify.js";
export type {
  VerifySellerInput,
  VerifySellerResult,
  CheckResult,
  CheckStatus,
  QuoteValidity,
  VerificationPolicy,
  RegistryPolicy,
  TcbPolicy,
} from "./verifier/verify.js";
export { validateQuote } from "./verifier/checks.js";
export {
  verifyQuoteGenuineness,
  QUOTE_VERIFIERS,
  isPlatformImplemented,
} from "./verifier/quote-verifiers.js";
export type { QuoteGenuineness, QuoteVerifierFn } from "./verifier/quote-verifiers.js";

// Low-level DCAP entry points, surfaced for registry-seeding tooling that must
// REAL-DCAP-verify a live seller's quote and derive its canonical measurement.
export { verifyTdxQuote, canonicalTdxMeasurement } from "./verifier/dcap.js";
export type { TdxVerification, TcbVerdict } from "./verifier/dcap.js";
