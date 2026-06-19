import { test, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createEvidenceHandler, createLauncherEvidenceHandler } from "./serving.js";
import { verifyEvidenceSignature, type EvidenceDocument } from "./document.js";
import { MockAttestation } from "../attestation/index.js";
import type { EvidenceContext } from "./routes.js";
import type { AttestationProvider, AttestationQuote } from "../attestation/types.js";

/** A mock provider that counts quote generations and can be made to block. */
function makeProvider(): AttestationProvider & {
  calls: number;
  gate?: { promise: Promise<void>; release: () => void };
} {
  const p = {
    platform: "mock" as const,
    calls: 0,
    gate: undefined as { promise: Promise<void>; release: () => void } | undefined,
    async isAvailable() {
      return true;
    },
    async generateQuote(): Promise<AttestationQuote> {
      p.calls++;
      if (p.gate) await p.gate.promise;
      return {
        platform: "mock",
        quote: new Uint8Array([1, 2, 3]),
        reportData: new Uint8Array(64),
        measurements: { mrtd: "aa" },
      };
    },
  };
  return p;
}

function ctxOf(p: AttestationProvider): EvidenceContext {
  return { attestation: p, peerPubkey: "aa".repeat(33), enclavePubkey: "ed".repeat(44) };
}

test("cheap paths bypass limiting and generate no quote", async () => {
  const p = makeProvider();
  const h = createEvidenceHandler(ctxOf(p), { rateLimitMax: 1 });
  const r = await h("/pubkey");
  expect(r?.status).toBe(200);
  expect(p.calls).toBe(0);
});

test("per-nonce cache: a repeated nonce within TTL generates exactly one quote", async () => {
  const p = makeProvider();
  let now = 1000;
  const h = createEvidenceHandler(ctxOf(p), { now: () => now, cacheTtlMs: 5000 });
  const a = await h("/evidence?nonce=abcd");
  const b = await h("/evidence?nonce=abcd");
  expect(a?.status).toBe(200);
  expect(b).toEqual(a);
  expect(p.calls).toBe(1); // second served from cache
  now += 6000; // past TTL -> regenerate
  await h("/evidence?nonce=abcd");
  expect(p.calls).toBe(2);
});

test("rate limit: requests past the window cap get 429, then reset", async () => {
  const p = makeProvider();
  let now = 1000;
  const h = createEvidenceHandler(ctxOf(p), {
    now: () => now,
    rateLimitMax: 2,
    rateLimitWindowMs: 10000,
  });
  expect((await h("/evidence?nonce=01"))?.status).toBe(200);
  expect((await h("/evidence?nonce=02"))?.status).toBe(200);
  expect((await h("/evidence?nonce=03"))?.status).toBe(429);
  now += 10000; // new window
  expect((await h("/evidence?nonce=04"))?.status).toBe(200);
});

test("bounded concurrency: a second in-flight quote is rejected with 503", async () => {
  const p = makeProvider();
  let release!: () => void;
  p.gate = { promise: new Promise<void>((r) => (release = r)), release: () => release() };
  const h = createEvidenceHandler(ctxOf(p), { maxConcurrentQuotes: 1 });

  const first = h("/evidence?nonce=aa"); // takes the only slot, blocks in generateQuote
  await new Promise((r) => setImmediate(r)); // let `first` reach the gate (inflight=1)
  const second = await h("/evidence?nonce=bb"); // slot busy -> 503
  expect(second?.status).toBe(503);

  release();
  expect((await first)?.status).toBe(200);
});

test("launcher handler: /evidence serves an enclave-signed doc bound to the nonce; /pubkey returns the keys", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const enclavePubkey = (publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("hex");
  const h = createLauncherEvidenceHandler({
    platform: "mock",
    attestation: new MockAttestation(),
    claims: ["hardware-genuine", "channel-key-bound"],
    peerPubkey: "aa".repeat(33),
    enclavePubkey,
    enclavePrivateKey: privateKey,
    channelPubkey: "cc".repeat(32),
  });

  const pub = await h("/pubkey");
  expect(pub?.status).toBe(200);
  expect((pub!.body as Record<string, unknown>).channelPubkey).toBe("cc".repeat(32));

  const ev = await h("/evidence?nonce=abcd");
  const doc = ev!.body as EvidenceDocument;
  expect(doc.schema).toBe("antseed-tee/launcher");
  expect(doc.nonce).toBe("abcd");
  expect(verifyEvidenceSignature(doc)).toBe(true);
});
