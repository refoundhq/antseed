/**
 * Local structural mirrors of `@antseed/node`'s seller-provider types, used ONLY
 * by the v2 `TeeAttestingProvider` decorator stub so this package typechecks
 * without `@antseed/node` being built (it is a types-only peerDependency).
 *
 * These mirror, field-for-field, the real interfaces:
 *   - SerializedHttpRequest / SerializedHttpResponse  (@antseed/node types/http)
 *   - Provider / ProviderStreamCallbacks              (@antseed/node interfaces/seller-provider)
 *
 * When the decorator is implemented for real, replace imports of these with
 * `import type { Provider, ... } from '@antseed/node'`.
 */

export interface SerializedHttpRequestLike {
  requestId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface SerializedHttpResponseLike {
  requestId: string;
  statusCode: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface SerializedHttpResponseChunkLike {
  requestId: string;
  data: Uint8Array;
  done: boolean;
}

export interface ProviderStreamCallbacksLike {
  onResponseStart: (response: SerializedHttpResponseLike) => void;
  onResponseChunk: (chunk: SerializedHttpResponseChunkLike) => void;
}

export interface ProviderPricingLike {
  defaults: {
    inputUsdPerMillion: number;
    outputUsdPerMillion: number;
    cachedInputUsdPerMillion?: number;
  };
  services?: Record<
    string,
    {
      inputUsdPerMillion: number;
      outputUsdPerMillion: number;
      cachedInputUsdPerMillion?: number;
    }
  >;
}

export interface ProviderLike {
  name: string;
  services: string[];
  pricing: ProviderPricingLike;
  maxConcurrency: number;
  handleRequest(req: SerializedHttpRequestLike): Promise<SerializedHttpResponseLike>;
  handleRequestStream?(
    req: SerializedHttpRequestLike,
    callbacks: ProviderStreamCallbacksLike,
  ): Promise<SerializedHttpResponseLike>;
  init?(): Promise<void>;
  getCapacity(): { current: number; max: number };
}
