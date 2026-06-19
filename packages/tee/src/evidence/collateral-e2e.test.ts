import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import type {
  AttestationProvider,
  AttestationQuote,
  ReportDataBindings,
} from "../attestation/types.js";
import { handleEvidenceRequest, type EvidenceBundle } from "./routes.js";
import { verifyTdxQuote } from "../verifier/dcap.js";
import { verifySeller } from "../verifier/verify.js";
import { RegistryClient } from "../registry/client.js";
import { signValidSet } from "../registry/test-helpers.js";

/**
 * End-to-end DCAP-collateral flow: a seller embeds the real fixture quote's
 * collateral into its /evidence bundle, and the buyer reconstructs the quote
 * from that bundle (carrying the collateral) and verifies it OFFLINE — no Intel
 * PCS call. Uses the committed real Intel TDX quote + collateral and pins the
 * verifier clock to the collateral validity window, exactly as dcap.test.ts.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "..", "verifier", "__fixtures__");
// Sample collateral is valid 2025-06-19..2025-07-19; pin DCAP time inside it.
const NOW_SECS = Math.floor(Date.parse("2025-06-20T00:00:00Z") / 1000);

function loadFixture(): { raw: Uint8Array; collateral: Record<string, string> } {
  const raw = new Uint8Array(
    Buffer.from(readFileSync(join(FIX, "tdx_quote.b64"), "utf8"), "base64"),
  );
  const collateral = JSON.parse(
    readFileSync(join(FIX, "tdx_quote_collateral.json"), "utf8"),
  ) as Record<string, string>;
  return { raw, collateral };
}

/**
 * A seller-side attestation provider that returns the real fixture TDX quote
 * with collateral already attached (as the live `TdxAttestation` would after a
 * PCS fetch). report_data is the fixture's own bytes — the routes layer copies
 * it into the bundle verbatim.
 */
class FixtureTdxProvider implements AttestationProvider {
  readonly platform = "tdx" as const;
  constructor(
    private readonly raw: Uint8Array,
    private readonly collateral: Record<string, string>,
  ) {}
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async generateQuote(_bindings: ReportDataBindings): Promise<AttestationQuote> {
    // 64-byte report_data lives at offset 568 in a v4 TDX quote body.
    const reportData = this.raw.slice(568, 568 + 64);
    return {
      platform: "tdx",
      quote: this.raw,
      reportData,
      measurements: {},
      collateral: this.collateral,
    };
  }
}

/** Mirror of the buyer-proxy `quoteFromBundle` (apps/cli/src/proxy/tee-verify.ts). */
function quoteFromBundle(bundle: EvidenceBundle): AttestationQuote {
  return {
    platform: bundle.platform,
    quote: new Uint8Array(Buffer.from(bundle.quote, "base64")),
    reportData: new Uint8Array(Buffer.from(bundle.reportDataHex, "hex")),
    measurements: bundle.measurements,
    ...(bundle.collateral ? { collateral: bundle.collateral } : {}),
  };
}

describe("evidence bundle carries DCAP collateral (buyer verifies offline)", () => {
  it("the /evidence bundle includes the seller's collateral", async () => {
    const { raw, collateral } = loadFixture();
    const reply = await handleEvidenceRequest(`/evidence?nonce=${"ab".repeat(32)}`, {
      attestation: new FixtureTdxProvider(raw, collateral),
      peerPubkey: "02" + "07".repeat(32),
      enclavePubkey: "ed".repeat(44),
    });
    expect(reply?.status).toBe(200);
    const bundle = reply!.body as EvidenceBundle;
    expect(bundle.collateral).toEqual(collateral);
  });

  it("buyer reconstructs the quote from the bundle and DCAP-verifies it offline", async () => {
    const { raw, collateral } = loadFixture();
    const reply = await handleEvidenceRequest(`/evidence?nonce=${"cd".repeat(32)}`, {
      attestation: new FixtureTdxProvider(raw, collateral),
      peerPubkey: "02" + "07".repeat(32),
      enclavePubkey: "ed".repeat(44),
    });
    const bundle = reply!.body as EvidenceBundle;

    // The buyer reconstructs the quote (collateral travels in the bundle) and
    // runs the REAL DCAP verifier — no Intel-PCS call. TCB evaluates UpToDate.
    const quote = quoteFromBundle(bundle);
    expect(quote.collateral).toBeDefined();
    const v = verifyTdxQuote(quote, NOW_SECS);
    expect(v.genuine).toBe(true);
    expect(v.tcbStatus).toBe("UpToDate");
  });

  it("verifySeller passes checks 1 (TCB via bundle collateral) and 2 (approved measurement)", async () => {
    const { raw, collateral } = loadFixture();

    // Approve the fixture's real measurement so check #2 passes.
    const measurement = verifyTdxQuote(
      { platform: "tdx", quote: raw, reportData: new Uint8Array(0), measurements: {}, collateral },
      NOW_SECS,
    ).measurement;
    const { set, signerHex } = signValidSet({
      version: 1,
      entries: [{ platform: "tdx", measurement, status: "active" }],
    });
    const registry = new RegistryClient({ pinnedSigner: signerHex });
    registry.loadFromObject(set);

    // Seller → /evidence bundle (with collateral) → buyer reconstruct.
    const reply = await handleEvidenceRequest(`/evidence?nonce=${"ef".repeat(32)}`, {
      attestation: new FixtureTdxProvider(raw, collateral),
      peerPubkey: "02" + "07".repeat(32),
      enclavePubkey: "ed".repeat(44),
    });
    const quote = quoteFromBundle(reply!.body as EvidenceBundle);

    const result = verifySeller({
      quote,
      // The fixture quote's report_data is fixed and not derived from these
      // bindings, so check #3 (channel/enclave/nonce bind) cannot pass here —
      // that path is covered by the mock e2e tests. This test isolates the
      // collateral-driven checks #1 and #2.
      connectedPeerPubkey: "02" + "07".repeat(32),
      enclavePubkey: "ed".repeat(44),
      nonce: "ef".repeat(32),
      registry,
      nowSecs: NOW_SECS,
    });

    const status = (id: number) => result.checks.find((c) => c.id === id)?.status;
    expect(status(1)).toBe("pass"); // genuine + debug-off + TCB-current, via bundle collateral
    expect(status(2)).toBe("pass"); // measurement ∈ approved set
    expect(status(3)).toBe("fail"); // report_data binding — not satisfiable by the canned fixture
  });
});
