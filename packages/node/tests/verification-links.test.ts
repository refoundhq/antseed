import { describe, expect, it } from "vitest";

import { collectPeerVerificationLinks, isGithubName, isGithubRepository } from "../src/discovery/verification-links.js";

const PEER_ID = "aa".repeat(20);

describe("verification links", () => {
  it("validates GitHub account and repository names", () => {
    expect(isGithubName("octocat")).toBe(true);
    expect(isGithubName("octo-cat")).toBe(true);
    expect(isGithubName("-octocat")).toBe(false);
    expect(isGithubName("bad user")).toBe(false);

    expect(isGithubRepository("antseed-proof")).toBe(true);
    expect(isGithubRepository("proof.repo")).toBe(true);
    expect(isGithubRepository("..")).toBe(false);
  });

  it("builds links for verified external claims only", () => {
    expect(collectPeerVerificationLinks({
      verificationResults: {
        verified: false,
        checkedAtMs: 123,
        domains: [
          {
            domain: "Example.com",
            peerId: PEER_ID,
            verified: true,
            method: "dns-txt",
            checkedAtMs: 123,
            attempts: [{ method: "dns-txt", verified: true }],
          },
          {
            domain: "unverified.example",
            peerId: PEER_ID,
            verified: false,
            checkedAtMs: 123,
            attempts: [{ method: "dns-txt", verified: false }],
          },
        ],
        github: [
          {
            username: "OctoCat",
            repository: "antseed-proof",
            peerId: PEER_ID,
            verified: true,
            checkedAtMs: 123,
          },
          {
            username: "bad user",
            repository: "repo",
            peerId: PEER_ID,
            verified: true,
            checkedAtMs: 123,
          },
        ],
      },
    })).toEqual([
      { kind: "domain", label: "example.com", href: "https://example.com" },
      { kind: "github", label: "@octocat/antseed-proof", href: "https://github.com/octocat/antseed-proof" },
    ]);
  });

  it("ignores malformed cached results", () => {
    expect(collectPeerVerificationLinks({
      verificationResults: {
        domains: [
          null,
          { verified: true, domain: "bad..example" },
          { verified: true, domain: 123 },
        ],
        github: [
          null,
          { verified: true, username: "octocat", repository: ".." },
          { verified: true, username: 123 },
        ],
      },
    })).toEqual([
      { kind: "github", label: "@octocat", href: "https://github.com/octocat" },
    ]);
  });
});
