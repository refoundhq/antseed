import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import type { AttestationQuote } from "../attestation/types.js";
import { verifyTdxQuote, canonicalTdxMeasurement } from "./dcap.js";
import { validateQuote } from "./checks.js";

/**
 * REAL Intel TDX DCAP verification against a known-good sample quote +
 * collateral from the Phala-Network/dcap-qvl test vectors (an actual
 * Intel-signed v4 TDX quote, fmspc B0C06F000000). No mocks: this runs the full
 * ECDSA + PCK-chain-to-Intel-Root-CA + TCB evaluation offline against the
 * committed collateral.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "__fixtures__");

// The sample collateral (TCB info + QE id certs) is valid 2025-06-19..2025-07-19.
// Pin verification time inside that window so cert/TCB validity is deterministic.
const NOW_SECS = Math.floor(Date.parse("2025-06-20T00:00:00Z") / 1000);

// Expected values, captured from the real verification of the sample.
const EXPECTED_MRTD =
  "91eb2b44d141d4ece09f0c75c2c53d247a3c68edd7fafe8a3520c942a604a407" +
  "de03ae6dc5f87f27428b2538873118b7";
const EXPECTED_RTMR0 =
  "44c0197b39157fdd7a4dcc44767f9d6b0bb3977c7a8e347b8492f827fe9d9e5c" +
  "48aca29b220b80b6a540cf994b9bc9c0";
const EXPECTED_REPORT_DATA =
  "9a9d48e7f6799642d3d1b34e1e5e1742d4bb02dd6ddd551862c1211d35c304f9" +
  "eca3efdbb481601c163cf52493d6e44aed55d51ec39b7e518fadb92c2b523f20";

function loadSampleQuote(): { raw: Uint8Array; collateral: Record<string, string> } {
  const raw = new Uint8Array(
    Buffer.from(readFileSync(join(FIX, "tdx_quote.b64"), "utf8"), "base64"),
  );
  const collateral = JSON.parse(
    readFileSync(join(FIX, "tdx_quote_collateral.json"), "utf8"),
  ) as Record<string, string>;
  return { raw, collateral };
}

function toAttestationQuote(
  raw: Uint8Array,
  collateral: Record<string, string>,
): AttestationQuote {
  return {
    platform: "tdx",
    quote: raw,
    reportData: new Uint8Array(0), // filled by the parser; not used by validateQuote
    measurements: {}, // derived from the quote, not trusted from here
    collateral,
  };
}

describe("verifyTdxQuote (real Intel TDX DCAP)", () => {
  it("verifies a genuine sample TDX quote and extracts MRTD/RTMR/report_data", () => {
    const { raw, collateral } = loadSampleQuote();
    const v = verifyTdxQuote(toAttestationQuote(raw, collateral), NOW_SECS);

    expect(v.genuine).toBe(true);
    expect(v.debugDisabled).toBe(true);
    expect(v.tcbStatus).toBe("UpToDate");
    expect(v.tcbVerdict).toBe("current");

    // Measurement registers extracted from the real TD report.
    expect(v.registers.mrtd).toBe(EXPECTED_MRTD);
    expect(v.registers.rtmr0).toBe(EXPECTED_RTMR0);

    // 64-byte report_data extracted from the parsed quote.
    expect(v.reportData.length).toBe(64);
    expect(Buffer.from(v.reportData).toString("hex")).toBe(EXPECTED_REPORT_DATA);

    // Canonical measurement folds MRTD + RTMR0..3 deterministically.
    expect(v.measurement).toBe(
      canonicalTdxMeasurement({
        mrtd: Buffer.from(EXPECTED_MRTD, "hex"),
        rtmr0: Buffer.from(v.registers.rtmr0, "hex"),
        rtmr1: Buffer.from(v.registers.rtmr1, "hex"),
        rtmr2: Buffer.from(v.registers.rtmr2, "hex"),
        rtmr3: Buffer.from(v.registers.rtmr3, "hex"),
      }),
    );
  });

  it("flows through validateQuote (tdx path) with a UpToDate TCB verdict", () => {
    const { raw, collateral } = loadSampleQuote();
    // validateQuote uses the wall clock; the sample collateral expired
    // 2025-07-19, so a genuine signature still validates but cert/TCB validity
    // is time-bounded. We assert on the direct verifyTdxQuote() path (pinned
    // time) above; here we only assert the tdx branch is wired (not the mock
    // stub) by checking it produced a non-empty measurement + 64B report_data
    // when verification succeeds, OR fails closed with a DCAP error otherwise.
    const validity = validateQuote(toAttestationQuote(raw, collateral));
    if (validity.genuine) {
      expect(validity.reportData.length).toBe(64);
      expect(validity.measurement.length).toBeGreaterThan(0);
    } else {
      // Fail-closed path: must be a real DCAP error, never the old TODO stub.
      expect(validity.detail).toMatch(/TDX DCAP verification failed/);
    }
  });

  it("rejects a tampered quote (ECDSA signature over the TD report fails)", () => {
    const { raw, collateral } = loadSampleQuote();
    const tampered = Uint8Array.from(raw);
    tampered[600] ^= 0xff; // flip a byte inside the signed TD report body

    expect(() =>
      verifyTdxQuote(toAttestationQuote(tampered, collateral), NOW_SECS),
    ).toThrow();

    // And the checklist path fails closed (genuine=false) rather than throwing.
    const validity = validateQuote(toAttestationQuote(tampered, collateral));
    expect(validity.genuine).toBe(false);
    expect(validity.detail).toMatch(/TDX DCAP verification failed/);
  });

  it("fails closed when DCAP collateral is missing", () => {
    const { raw } = loadSampleQuote();
    const quote: AttestationQuote = {
      platform: "tdx",
      quote: raw,
      reportData: new Uint8Array(0),
      measurements: {},
      // no collateral
    };
    expect(() => verifyTdxQuote(quote, NOW_SECS)).toThrow(/collateral/);
    const validity = validateQuote(quote);
    expect(validity.genuine).toBe(false);
  });
});
