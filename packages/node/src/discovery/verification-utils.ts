// Shared internals for external-claim verifiers (domain-verification.ts,
// github-verification.ts). Not exported from the package index.

export const DEFAULT_VERIFICATION_TIMEOUT_MS = 3_000;
// Proofs are tiny JSON documents; cap reads so a hostile host can't stream
// an unbounded body into the verifying client.
export const MAX_VERIFICATION_PROOF_BYTES = 4_096;

export function normalizePeerId(peerId: string): string {
  return peerId.trim().toLowerCase().replace(/^0x/, "");
}

export function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err); },
    );
  });
}

export function withTimeoutSignal(signal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("verification request timed out")), timeoutMs);
  if (!signal) {
    return {
      signal: controller.signal,
      cleanup: () => clearTimeout(timer),
    };
  }
  const onAbort = () => controller.abort(signal.reason);
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    },
  };
}

export async function readBodyWithLimit(response: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`Proof body exceeds ${maxBytes} bytes`);
  }
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error(`Proof body exceeds ${maxBytes} bytes`);
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`Proof body exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}
