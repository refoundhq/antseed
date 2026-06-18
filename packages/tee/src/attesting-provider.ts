/**
 * v2 — Optional model-call transcript decorator (requirement #4).
 *
 * INTERFACE ONLY for the MVP. This decorator wraps any `Provider` (the
 * `@antseed/node` seller-provider interface) and signs `{ requestedModel,
 * requestedEffort, servedModelEcho }` with the enclave key so a buyer can verify
 * the served model/effort echo against `peerPubkey`. It touches no buyer content
 * and does NOT prove the upstream provider actually ran that model — only that
 * the seller asked for it over the outbound RPC.
 *
 * It is declared as a structural mirror of `@antseed/node`'s `Provider`
 * (peerDependency, types-only) so the package typechecks without `@antseed/node`
 * being built. When wired up, swap `ProviderLike` for the real
 * `import type { Provider } from '@antseed/node'` and implement the bodies.
 */

import type {
  SerializedHttpRequestLike,
  SerializedHttpResponseLike,
  ProviderLike,
  ProviderStreamCallbacksLike,
} from "./internal/provider-types.js";

/** v2 enclave signer abstraction (secp256k1, matches peer identity curve). */
export interface EnclaveSigner {
  /** Hex public key — the same key bound into report_data as `peerPubkey`. */
  readonly peerPubkey: string;
  /** Sign canonical bytes, returning a hex signature. */
  sign(message: Uint8Array): string;
}

/**
 * v2 — Decorator that attaches a signed model-call transcript header. Interface
 * declared; method bodies intentionally unimplemented for the MVP.
 */
export declare class TeeAttestingProvider implements ProviderLike {
  constructor(inner: ProviderLike, signer: EnclaveSigner);

  // Metadata fields delegate to the wrapped provider.
  readonly name: string;
  readonly services: string[];
  readonly pricing: ProviderLike["pricing"];
  readonly maxConcurrency: number;

  handleRequest(req: SerializedHttpRequestLike): Promise<SerializedHttpResponseLike>;
  handleRequestStream?(
    req: SerializedHttpRequestLike,
    callbacks: ProviderStreamCallbacksLike,
  ): Promise<SerializedHttpResponseLike>;
  getCapacity(): { current: number; max: number };
}
