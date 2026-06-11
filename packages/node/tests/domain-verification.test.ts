import { describe, expect, it } from "vitest";

import {
  DOMAIN_VERIFICATION_WELL_KNOWN_TYPE,
  buildDomainVerificationTxtValue,
  buildDomainVerificationWellKnownProof,
  verifyDomainVerificationClaim,
  verifyPeerMetadataDomains,
} from "../src/discovery/domain-verification.js";
import type { PeerMetadata } from "../src/discovery/peer-metadata.js";

const PEER_ID = "aa".repeat(20);

describe("domain verification", () => {
  it("builds DNS TXT and well-known proof payloads", () => {
    expect(buildDomainVerificationTxtValue(`0x${PEER_ID}`)).toBe(`antseed-peer=${PEER_ID}`);
    expect(buildDomainVerificationWellKnownProof(PEER_ID, "Example.COM")).toEqual({
      type: DOMAIN_VERIFICATION_WELL_KNOWN_TYPE,
      peerId: PEER_ID,
      domain: "example.com",
    });
  });

  it("verifies a DNS TXT proof", async () => {
    const result = await verifyDomainVerificationClaim(
      { domain: "example.com", methods: ["dns-txt"] },
      PEER_ID,
      {
        resolveTxt: async (hostname) => {
          expect(hostname).toBe("_antseed.example.com");
          return [[`antseed-peer=${PEER_ID}`]];
        },
      },
    );

    expect(result.verified).toBe(true);
    expect(result.method).toBe("dns-txt");
  });

  it("verifies an HTTPS well-known proof", async () => {
    const result = await verifyDomainVerificationClaim(
      { domain: "example.com", methods: ["https-well-known"] },
      PEER_ID,
      {
        fetch: async (input, init) => {
          expect(String(input)).toBe("https://example.com/.well-known/antseed.json");
          expect(init?.redirect).toBe("error");
          return new Response(JSON.stringify({
            type: DOMAIN_VERIFICATION_WELL_KNOWN_TYPE,
            peerId: PEER_ID,
            domain: "example.com",
          }), { status: 200 });
        },
      },
    );

    expect(result.verified).toBe(true);
    expect(result.method).toBe("https-well-known");
  });

  it("rejects oversized well-known proof bodies", async () => {
    const result = await verifyDomainVerificationClaim(
      { domain: "example.com", methods: ["https-well-known"] },
      PEER_ID,
      {
        fetch: async () => new Response(`"${"x".repeat(64 * 1024)}"`, { status: 200 }),
      },
    );

    expect(result.verified).toBe(false);
    expect(result.attempts[0]?.error).toMatch(/exceeds/);
  });

  it("times out hung DNS TXT lookups", async () => {
    const result = await verifyDomainVerificationClaim(
      { domain: "example.com", methods: ["dns-txt"] },
      PEER_ID,
      {
        timeoutMs: 20,
        resolveTxt: () => new Promise(() => {}),
      },
    );

    expect(result.verified).toBe(false);
    expect(result.attempts[0]?.error).toMatch(/timed out/);
  });

  it("reports failed attempts when proofs do not match", async () => {
    const result = await verifyDomainVerificationClaim(
      { domain: "example.com" },
      PEER_ID,
      {
        resolveTxt: async () => [["antseed-peer=bb"]],
        fetch: async () => new Response(JSON.stringify({
          type: DOMAIN_VERIFICATION_WELL_KNOWN_TYPE,
          peerId: "bb",
          domain: "example.com",
        }), { status: 200 }),
      },
    );

    expect(result.verified).toBe(false);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts.every((attempt) => !attempt.verified && attempt.error)).toBe(true);
  });

  it("verifies every domain claim in peer metadata", async () => {
    const metadata: PeerMetadata = {
      peerId: PEER_ID,
      version: 9,
      providers: [],
      region: "unknown",
      timestamp: 1,
      signature: "bb".repeat(65),
      verifications: {
        domains: [
          { domain: "a.example.com", methods: ["dns-txt"] },
          { domain: "b.example.com", methods: ["dns-txt"] },
        ],
      },
    };

    const results = await verifyPeerMetadataDomains(metadata, {
      resolveTxt: async (hostname) => [[hostname === "_antseed.a.example.com" ? `antseed-peer=${PEER_ID}` : "nope"]],
    });

    expect(results.map((result) => result.verified)).toEqual([true, false]);
  });
});
