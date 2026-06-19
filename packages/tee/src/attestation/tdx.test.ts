import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TdxAttestation, parseTdxMeasurements } from "./tdx.js";
import { packReportData } from "../report-data.js";

const PEER_PUBKEY = "02" + "07".repeat(32);
const ENCLAVE_PUBKEY = "ed".repeat(44);
const NONCE = "ab".repeat(32);

// TDX v4 quote layout: 48-byte header + 584-byte td_quote_body.
// Field offsets are relative to the start of the quote (header included).
const MRTD_OFF = 184;
const RTMR0_OFF = 376;
const RTMR1_OFF = 424;
const RTMR2_OFF = 472;
const RTMR3_OFF = 520;
const REPORTDATA_OFF = 568;
const QUOTE_LEN = 48 + 584; // 632

/** Build a structurally-valid fake TDX quote with the given report_data + regs. */
function fakeQuote(reportData: Uint8Array): Uint8Array {
  const quote = new Uint8Array(QUOTE_LEN);
  // Distinct, recognizable measurement registers.
  quote.fill(0x11, MRTD_OFF, MRTD_OFF + 48);
  quote.fill(0x20, RTMR0_OFF, RTMR0_OFF + 48);
  quote.fill(0x21, RTMR1_OFF, RTMR1_OFF + 48);
  quote.fill(0x22, RTMR2_OFF, RTMR2_OFF + 48);
  quote.fill(0x23, RTMR3_OFF, RTMR3_OFF + 48);
  quote.set(reportData, REPORTDATA_OFF);
  return quote;
}

describe("parseTdxMeasurements", () => {
  it("extracts MRTD + RTMR0..3 at the canonical offsets", () => {
    const m = parseTdxMeasurements(fakeQuote(new Uint8Array(64)));
    expect(m.mrtd).toBe("11".repeat(48));
    expect(m.rtmr0).toBe("20".repeat(48));
    expect(m.rtmr1).toBe("21".repeat(48));
    expect(m.rtmr2).toBe("22".repeat(48));
    expect(m.rtmr3).toBe("23".repeat(48));
  });

  it("returns an empty map for quotes too short to hold a v4 body", () => {
    expect(parseTdxMeasurements(new Uint8Array(64))).toEqual({});
  });
});

/** A stub DCAP collateral fetcher — no network. Mimics the embedded collateral. */
const STUB_COLLATERAL = { tcb_info: "{}", qe_identity: "{}", pck_crl: "00" } as const;
const stubFetcher = async (): Promise<Record<string, string>> => ({ ...STUB_COLLATERAL });

describe("TdxAttestation configfs-tsm round-trip (fake configfs path)", () => {
  let root: string;
  let outblob: Uint8Array;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "antseed-tsm-"));
    // Pre-stage what a real kernel would produce: a quote whose embedded
    // report_data equals packReportData(bindings). Generated lazily on read,
    // so compute it from the same bindings the test will request.
    outblob = fakeQuote(packReportData({ peerPubkey: PEER_PUBKEY, enclavePubkey: ENCLAVE_PUBKEY, nonce: NONCE }));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("writes report_data and returns a quote that binds it, with DCAP collateral", async () => {
    const att = new TdxAttestation({
      configfsTsmDir: root,
      tdxGuestDev: "/nonexistent/tdx_guest",
      collateralFetcher: stubFetcher, // no Intel-PCS network in tests
    });

    // Drive the kernel simulation: poll for the report node the provider creates,
    // then drop the staged outblob/provider into it.
    const stop = pollAndStage(root, outblob);
    try {
      const quote = await att.generateQuote({ peerPubkey: PEER_PUBKEY, enclavePubkey: ENCLAVE_PUBKEY, nonce: NONCE });
      expect(quote.platform).toBe("tdx");
      // report_data returned == canonical packReportData(bindings).
      const expected = packReportData({ peerPubkey: PEER_PUBKEY, enclavePubkey: ENCLAVE_PUBKEY, nonce: NONCE });
      expect(Buffer.from(quote.reportData).toString("hex")).toBe(
        Buffer.from(expected).toString("hex"),
      );
      // Measurements parsed from the embedded TD body.
      expect(quote.measurements.mrtd).toBe("11".repeat(48));
      expect(quote.measurements.rtmr0).toBe("20".repeat(48));
      // DCAP collateral is fetched (here: stubbed) and attached to the quote so
      // the evidence bundle can carry it for offline buyer verification.
      expect(quote.collateral).toEqual(STUB_COLLATERAL);
    } finally {
      stop();
    }
  });

  it("prefers a usable auxblob over fetching collateral", async () => {
    const auxCollateral = { tcb_info: "{\"id\":\"TDX\"}", qe_identity: "{}", pck_crl: "ab" };
    let fetched = false;
    const att = new TdxAttestation({
      configfsTsmDir: root,
      tdxGuestDev: "/nonexistent/tdx_guest",
      collateralFetcher: async () => {
        fetched = true;
        return { ...STUB_COLLATERAL };
      },
    });
    const stop = pollAndStage(root, outblob, JSON.stringify(auxCollateral));
    try {
      const quote = await att.generateQuote({ peerPubkey: PEER_PUBKEY, enclavePubkey: ENCLAVE_PUBKEY, nonce: NONCE });
      expect(quote.collateral).toEqual(auxCollateral);
      expect(fetched).toBe(false); // auxblob was usable → no fetch
    } finally {
      stop();
    }
  });

  it("omits collateral when skipCollateral is set", async () => {
    const att = new TdxAttestation({
      configfsTsmDir: root,
      tdxGuestDev: "/nonexistent/tdx_guest",
      skipCollateral: true,
    });
    const stop = pollAndStage(root, outblob);
    try {
      const quote = await att.generateQuote({ peerPubkey: PEER_PUBKEY, enclavePubkey: ENCLAVE_PUBKEY, nonce: NONCE });
      expect(quote.collateral).toBeUndefined();
    } finally {
      stop();
    }
  });

  it("isAvailable() is true when the configfs report dir exists", async () => {
    const att = new TdxAttestation({
      configfsTsmDir: root,
      tdxGuestDev: "/nonexistent/tdx_guest",
    });
    expect(await att.isAvailable()).toBe(true);
  });

  it("isAvailable() is false when no TDX interface is present", async () => {
    const att = new TdxAttestation({
      configfsTsmDir: "/nonexistent/tsm",
      tdxGuestDev: "/nonexistent/tdx_guest",
    });
    expect(await att.isAvailable()).toBe(false);
  });

  it("rejects an empty outblob", async () => {
    const att = new TdxAttestation({
      configfsTsmDir: root,
      tdxGuestDev: "/nonexistent/tdx_guest",
    });
    const stop = pollAndStage(root, new Uint8Array(0));
    try {
      await expect(
        att.generateQuote({ peerPubkey: PEER_PUBKEY, enclavePubkey: ENCLAVE_PUBKEY, nonce: NONCE }),
      ).rejects.toThrow(/outblob was empty/);
    } finally {
      stop();
    }
  });
});

/**
 * Poll the configfs root for the report node the provider mkdir's, then write
 * the staged outblob + provider + generation into it — mimicking the kernel
 * materializing a quote when inblob is written. Returns a stop() to clear the
 * timer.
 */
function pollAndStage(root: string, outblob: Uint8Array, auxblob?: string): () => void {
  let stopped = false;
  const seen = new Set<string>();
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const entries = await fs.readdir(root);
      for (const name of entries) {
        if (seen.has(name)) continue;
        const dir = join(root, name);
        // Wait until inblob has been written by the provider before staging.
        try {
          await fs.access(join(dir, "inblob"));
        } catch {
          continue;
        }
        seen.add(name);
        // Stage the sidecar blobs first and write `outblob` LAST: the consumer
        // keys off outblob (readOutblobWithRetry), so writing it last guarantees
        // auxblob/provider/generation are already present when the quote read
        // proceeds — deterministic, no staging race.
        if (auxblob !== undefined) await fs.writeFile(join(dir, "auxblob"), auxblob);
        await fs.writeFile(join(dir, "provider"), "tdx_guest\n");
        await fs.writeFile(join(dir, "generation"), "1\n");
        await fs.writeFile(join(dir, "outblob"), outblob);
      }
    } catch {
      /* root may not exist yet */
    }
    if (!stopped) setTimeout(() => void tick(), 2);
  };
  void tick();
  return () => {
    stopped = true;
  };
}
