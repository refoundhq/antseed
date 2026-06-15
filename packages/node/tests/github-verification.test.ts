import { describe, expect, it } from "vitest";

import {
  GITHUB_VERIFICATION_PROOF_TYPE,
  buildGithubVerificationProof,
  buildGithubVerificationProofUrl,
  verifyGithubVerificationClaim,
  verifyPeerMetadataGithub,
} from "../src/discovery/github-verification.js";
import type { PeerMetadata } from "../src/discovery/peer-metadata.js";

const PEER_ID = "aa".repeat(20);

function proofResponse(peerId: string, username: string): Response {
  return new Response(JSON.stringify({
    type: GITHUB_VERIFICATION_PROOF_TYPE,
    peerId,
    username,
  }), { status: 200 });
}

describe("github verification", () => {
  it("builds proof payload and URL with the profile repo default", () => {
    expect(buildGithubVerificationProof(`0x${PEER_ID}`, "Octocat")).toEqual({
      type: GITHUB_VERIFICATION_PROOF_TYPE,
      peerId: PEER_ID,
      username: "octocat",
    });
    expect(buildGithubVerificationProofUrl({ username: "Octocat" }))
      .toBe("https://raw.githubusercontent.com/octocat/octocat/HEAD/antseed.json");
    expect(buildGithubVerificationProofUrl({ username: "octocat", repository: "my-proofs" }))
      .toBe("https://raw.githubusercontent.com/octocat/my-proofs/HEAD/antseed.json");
  });

  it("verifies a valid proof without following redirects", async () => {
    const result = await verifyGithubVerificationClaim(
      { username: "octocat" },
      PEER_ID,
      {
        fetch: async (input, init) => {
          expect(String(input)).toBe("https://raw.githubusercontent.com/octocat/octocat/HEAD/antseed.json");
          expect(init?.redirect).toBe("error");
          return proofResponse(PEER_ID, "octocat");
        },
      },
    );

    expect(result.verified).toBe(true);
    expect(result.repository).toBe("octocat");
  });

  it("rejects proofs for a different peer or username", async () => {
    const wrongPeer = await verifyGithubVerificationClaim(
      { username: "octocat" },
      PEER_ID,
      { fetch: async () => proofResponse("bb".repeat(20), "octocat") },
    );
    expect(wrongPeer.verified).toBe(false);
    expect(wrongPeer.error).toMatch(/peerId/);

    const wrongUser = await verifyGithubVerificationClaim(
      { username: "octocat" },
      PEER_ID,
      { fetch: async () => proofResponse(PEER_ID, "someone-else") },
    );
    expect(wrongUser.verified).toBe(false);
    expect(wrongUser.error).toMatch(/username/);
  });

  it("rejects oversized proof bodies", async () => {
    const result = await verifyGithubVerificationClaim(
      { username: "octocat" },
      PEER_ID,
      { fetch: async () => new Response(`"${"x".repeat(64 * 1024)}"`, { status: 200 }) },
    );

    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/exceeds/);
  });

  it("verifies every github claim in peer metadata", async () => {
    const metadata: PeerMetadata = {
      peerId: PEER_ID,
      version: 9,
      providers: [],
      region: "unknown",
      timestamp: 1,
      signature: "bb".repeat(65),
      verifications: {
        github: [
          { username: "octocat" },
          { username: "hubber", repository: "proofs" },
        ],
      },
    };

    const results = await verifyPeerMetadataGithub(metadata, {
      fetch: async (input) => String(input).includes("/octocat/")
        ? proofResponse(PEER_ID, "octocat")
        : new Response("not found", { status: 404 }),
    });

    expect(results.map((result) => result.verified)).toEqual([true, false]);
  });
});
