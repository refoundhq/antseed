import { describe, it, expect } from "vitest";
import { MockAttestation } from "../attestation/mock.js";
import { packReportData } from "../report-data.js";
import { handleEvidenceRequest, type EvidenceContext } from "./routes.js";

const PEER_PUBKEY = "02" + "07".repeat(32);
const ENCLAVE_PUBKEY = "ed".repeat(44);

function ctx(): EvidenceContext {
  return {
    attestation: new MockAttestation(),
    peerPubkey: PEER_PUBKEY,
    enclavePubkey: ENCLAVE_PUBKEY,
  };
}

describe("handleEvidenceRequest", () => {
  it("returns null for unrelated paths", async () => {
    expect(await handleEvidenceRequest("/metadata", ctx())).toBeNull();
    expect(await handleEvidenceRequest("/", ctx())).toBeNull();
  });

  it("serves /pubkey with both the channel and enclave keys", async () => {
    const reply = await handleEvidenceRequest("/pubkey", ctx());
    expect(reply?.status).toBe(200);
    expect(reply?.body).toEqual({ peerPubkey: PEER_PUBKEY, enclavePubkey: ENCLAVE_PUBKEY });
  });

  it("serves the well-known descriptor", async () => {
    const reply = await handleEvidenceRequest("/.well-known/antseed-evidence", ctx());
    expect(reply?.status).toBe(200);
    expect(reply?.body).toMatchObject({
      scheme: "antseed-tee/v1",
      platform: "mock",
      evidencePath: "/evidence",
      pubkeyPath: "/pubkey",
    });
  });

  it("issues a fresh evidence bundle bound to the nonce", async () => {
    const nonce = "ab".repeat(32);
    const reply = await handleEvidenceRequest(`/evidence?nonce=${nonce}`, ctx());
    expect(reply?.status).toBe(200);
    const body = reply!.body as Record<string, unknown>;
    expect(body.scheme).toBe("antseed-tee/v1");
    expect(body.nonce).toBe(nonce);
    expect(body.peerPubkey).toBe(PEER_PUBKEY);
    expect(body.enclavePubkey).toBe(ENCLAVE_PUBKEY);

    // report_data in the bundle must equal the canonical recompute over BOTH keys.
    const expected = Buffer.from(
      packReportData({ peerPubkey: PEER_PUBKEY, enclavePubkey: ENCLAVE_PUBKEY, nonce }),
    ).toString("hex");
    expect(body.reportDataHex).toBe(expected);
  });

  it("rejects a missing/malformed nonce", async () => {
    const r1 = await handleEvidenceRequest("/evidence", ctx());
    expect(r1?.status).toBe(400);
    const r2 = await handleEvidenceRequest("/evidence?nonce=xyz", ctx());
    expect(r2?.status).toBe(400);
  });
});
