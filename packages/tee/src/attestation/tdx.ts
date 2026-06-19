import { promises as fs } from "node:fs";
import { openSync, closeSync } from "node:fs";
import { packReportData } from "../report-data.js";
import { fetchTdxCollateral, type WireCollateral } from "./collateral.js";
import type {
  AttestationProvider,
  AttestationQuote,
  ReportDataBindings,
} from "./types.js";

/**
 * Intel TDX attestation via the in-kernel `configfs-tsm` report interface
 * (preferred) with a `/dev/tdx_guest` ioctl fallback.
 *
 * configfs-tsm flow (kernel >= 6.7):
 *   1. mkdir a report node:   /sys/kernel/config/tsm/report/<name>
 *   2. write the 64-byte report_data to  <name>/inblob
 *   3. read the raw quote from            <name>/outblob
 *   4. read provider ("tdx_guest") + generation for diagnostics
 *   5. rmdir <name>
 *
 * `/dev/tdx_guest` fallback (older kernels without the TSM bridge): issue the
 * TDX_CMD_GET_QUOTE ioctl with a tdx_quote_req buffer (report_data in,
 * DCAP quote out). The ioctl path needs a raw `ioctl(2)` syscall; we shell out
 * to it only when configfs-tsm is absent.
 *
 * Quote VERIFICATION (vendor PKI / TCB) is the verifier's job — see
 * verifier/checks.ts. Quote GENERATION here is local-only and makes no network
 * call. We additionally parse the embedded TD report body to surface
 * MRTD/RTMR0..3 in `measurements`; the verifier independently re-parses the raw
 * quote and is the authority on those values.
 */

const DEFAULT_CONFIGFS_TSM_DIR = "/sys/kernel/config/tsm/report";
const DEFAULT_TDX_GUEST_DEV = "/dev/tdx_guest";

/** TDX v4 quote layout (Intel DCAP). Header is 48 bytes; the TD report body
 * (td_quote_body, 584 bytes) follows. Offsets below are relative to the START
 * OF THE QUOTE (header included). */
const QUOTE_HEADER_LEN = 48;
const TD_BODY_OFF = QUOTE_HEADER_LEN; // 48
// Field offsets within td_quote_body, plus the header offset → absolute.
const MRTD_OFF = TD_BODY_OFF + 136; // 184
const RTMR0_OFF = TD_BODY_OFF + 328; // 376
const RTMR1_OFF = TD_BODY_OFF + 376; // 424
const RTMR2_OFF = TD_BODY_OFF + 424; // 472
const RTMR3_OFF = TD_BODY_OFF + 472; // 520
const REPORTDATA_OFF = TD_BODY_OFF + 520; // 568
const MEASUREMENT_LEN = 48;
const REPORTDATA_LEN = 64;
/** Smallest quote we will attempt to parse measurements from. */
const MIN_QUOTE_LEN = REPORTDATA_OFF + REPORTDATA_LEN; // 632

export interface TdxAttestationOptions {
  /** Override the configfs-tsm report root (defaults to the kernel path). For tests. */
  configfsTsmDir?: string;
  /** Override the tdx_guest device path (defaults to /dev/tdx_guest). For tests. */
  tdxGuestDev?: string;
  /**
   * PCCS/Intel-PCS base URL for collateral fetching. Defaults to Intel PCS.
   * Set to a PCCS mirror (e.g. Phala's) for better availability/rate limits.
   */
  pccsUrl?: string;
  /**
   * Skip the DCAP-collateral fetch entirely (quote ships without
   * `collateral`). Default false — a TDX seller's evidence must carry collateral
   * so the buyer verifies offline. For tests/diagnostics only.
   */
  skipCollateral?: boolean;
  /**
   * Override the collateral fetcher (tests). Defaults to {@link fetchTdxCollateral},
   * which fetches from Intel PCS by FMSPC and caches in-process.
   */
  collateralFetcher?: (quote: Uint8Array) => Promise<WireCollateral>;
}

export class TdxAttestation implements AttestationProvider {
  readonly platform = "tdx" as const;

  private readonly configfsTsmDir: string;
  private readonly tdxGuestDev: string;
  private readonly skipCollateral: boolean;
  private readonly fetchCollateral: (quote: Uint8Array) => Promise<WireCollateral>;

  constructor(opts: TdxAttestationOptions = {}) {
    this.configfsTsmDir = opts.configfsTsmDir ?? DEFAULT_CONFIGFS_TSM_DIR;
    this.tdxGuestDev = opts.tdxGuestDev ?? DEFAULT_TDX_GUEST_DEV;
    this.skipCollateral = opts.skipCollateral ?? false;
    this.fetchCollateral =
      opts.collateralFetcher ?? ((q) => fetchTdxCollateral(q, opts.pccsUrl));
  }

  async isAvailable(): Promise<boolean> {
    // Present if either the configfs-tsm report dir or the tdx_guest device exists.
    if (await pathExists(this.configfsTsmDir)) return true;
    return pathExists(this.tdxGuestDev);
  }

  async generateQuote(bindings: ReportDataBindings): Promise<AttestationQuote> {
    const reportData = packReportData(bindings); // 64 bytes

    if (await pathExists(this.configfsTsmDir)) {
      return this.quoteViaConfigfsTsm(reportData);
    }
    if (await pathExists(this.tdxGuestDev)) {
      return this.quoteViaTdxGuest(reportData);
    }
    throw new Error(
      "TdxAttestation.generateQuote: no TDX interface found " +
        `(${this.configfsTsmDir} or ${this.tdxGuestDev}). Not running under Intel TDX?`,
    );
  }

  /**
   * configfs-tsm path. Creates a unique report node, writes report_data to
   * `inblob`, reads the raw DCAP quote from `outblob`, then removes the node.
   * `provider`/`generation` are read for diagnostics (best-effort).
   */
  private async quoteViaConfigfsTsm(
    reportData: Uint8Array,
  ): Promise<AttestationQuote> {
    const name = `antseed-${process.pid}-${Date.now()}`;
    const dir = `${this.configfsTsmDir}/${name}`;
    await fs.mkdir(dir);
    try {
      // Writing inblob both supplies report_data and bumps `generation`. The
      // outblob read then triggers quote generation against that input. Some
      // kernels populate outblob asynchronously (QGS round-trip), surfacing a
      // transient ENOENT/empty read — retry briefly before giving up.
      await fs.writeFile(`${dir}/inblob`, reportData);
      const quote = await readOutblobWithRetry(`${dir}/outblob`);
      if (quote.length === 0) {
        throw new Error(
          "TdxAttestation: configfs-tsm outblob was empty — the quote-generation " +
            "service (QGS/vsock) is likely unreachable from this guest.",
        );
      }

      const provider = await readTextBestEffort(`${dir}/provider`);
      if (provider && !provider.toLowerCase().includes("tdx")) {
        throw new Error(
          `TdxAttestation: configfs-tsm provider is "${provider}", expected a tdx_guest provider.`,
        );
      }

      const measurements = parseTdxMeasurements(quote);
      assertBindsReportData(quote, reportData);

      // DCAP collateral: prefer a usable auxblob if the kernel/QGS already
      // supplied one, else fetch from Intel PCS by FMSPC (cached).
      const auxCollateral = await readAuxblobCollateral(dir);
      const collateral = await this.resolveCollateral(quote, auxCollateral);

      return {
        platform: "tdx",
        quote,
        reportData,
        measurements,
        ...(collateral ? { collateral } : {}),
      };
    } finally {
      await fs.rmdir(dir).catch(() => {
        /* node may already be gone */
      });
    }
  }

  /**
   * Legacy `/dev/tdx_guest` ioctl path. Newer kernels expose configfs-tsm and
   * this branch is skipped. Uses TDX_CMD_GET_QUOTE which takes a tdx_quote_req
   * (report_data → DCAP quote) in a single ioctl.
   */
  private async quoteViaTdxGuest(
    reportData: Uint8Array,
  ): Promise<AttestationQuote> {
    const quote = await getQuoteViaIoctl(this.tdxGuestDev, reportData);
    if (quote.length === 0) {
      throw new Error(
        "TdxAttestation: /dev/tdx_guest returned an empty quote (QGS unreachable?).",
      );
    }
    const measurements = parseTdxMeasurements(quote);
    assertBindsReportData(quote, reportData);
    const collateral = await this.resolveCollateral(quote, null);
    return {
      platform: "tdx",
      quote,
      reportData,
      measurements,
      ...(collateral ? { collateral } : {}),
    };
  }

  /**
   * Resolve DCAP collateral for a quote: use the auxblob-supplied collateral when
   * the kernel/QGS already produced a usable (structured) one, else fetch from
   * Intel PCS by FMSPC. Returns null only when collateral fetching is disabled.
   * A fetch failure throws — a TDX seller with no collateral cannot be verified
   * offline by buyers, so failing here surfaces the problem at seed/serve time.
   */
  private async resolveCollateral(
    quote: Uint8Array,
    auxCollateral: WireCollateral | null,
  ): Promise<WireCollateral | undefined> {
    if (this.skipCollateral) return undefined;
    if (auxCollateral) return auxCollateral;
    return this.fetchCollateral(quote);
  }
}

/**
 * Best-effort read of the configfs-tsm `auxblob` as structured DCAP collateral.
 * Some QGS/kernel paths populate `auxblob` with the JSON `Collateral` shape the
 * verifier needs; when present and parseable with the required fields, we use it
 * and skip the Intel-PCS fetch. Anything else (raw binary blob, absent, partial)
 * returns null so the caller fetches collateral instead.
 */
async function readAuxblobCollateral(dir: string): Promise<WireCollateral | null> {
  let aux: Buffer;
  try {
    aux = await fs.readFile(`${dir}/auxblob`);
  } catch {
    return null; // auxblob absent
  }
  if (aux.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(aux.toString("utf8"));
  } catch {
    return null; // not JSON — a raw binary blob we cannot map to Collateral
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const required = ["pck_crl", "tcb_info", "qe_identity"];
  if (!required.every((k) => typeof obj[k] === "string" || Array.isArray(obj[k]))) {
    return null;
  }
  const out: WireCollateral = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") out[k] = v;
    else if (Array.isArray(v)) out[k] = Buffer.from(v as number[]).toString("hex");
  }
  return out;
}

/**
 * Extract MRTD + RTMR0..3 from a TDX DCAP quote's TD report body. Returns hex
 * strings keyed by register name. If the quote is shorter than a v4 body
 * (e.g. an unexpected provider format), returns an empty map rather than
 * throwing — the verifier re-parses the raw quote regardless.
 */
export function parseTdxMeasurements(quote: Uint8Array): Record<string, string> {
  if (quote.length < MIN_QUOTE_LEN) return {};
  const buf = Buffer.from(quote.buffer, quote.byteOffset, quote.byteLength);
  const hexAt = (off: number): string =>
    buf.subarray(off, off + MEASUREMENT_LEN).toString("hex");
  return {
    mrtd: hexAt(MRTD_OFF),
    rtmr0: hexAt(RTMR0_OFF),
    rtmr1: hexAt(RTMR1_OFF),
    rtmr2: hexAt(RTMR2_OFF),
    rtmr3: hexAt(RTMR3_OFF),
  };
}

/**
 * Sanity check: the report_data embedded in the quote must equal the value we
 * asked the hardware to bind. A mismatch means the quote was generated for a
 * different request (or a parser/layout bug) — refuse it. Skipped for quotes
 * too short to contain a v4 report body.
 */
function assertBindsReportData(quote: Uint8Array, expected: Uint8Array): void {
  if (quote.length < MIN_QUOTE_LEN) return;
  for (let i = 0; i < REPORTDATA_LEN; i++) {
    if (quote[REPORTDATA_OFF + i] !== expected[i]) {
      throw new Error(
        "TdxAttestation: quote report_data does not match the requested bindings.",
      );
    }
  }
}

/**
 * Issue the TDX_CMD_GET_QUOTE ioctl against `/dev/tdx_guest`.
 *
 * The Linux uapi for this is a `struct tdx_quote_req { __u64 buf; __u64 len; }`
 * where `buf` points to a 4-byte-aligned region: a header followed by the
 * 64-byte report_data on the way in, and the DCAP quote on the way out. Issuing
 * a raw ioctl from Node requires a syscall binding, which we expose via a thin
 * native shim resolved at runtime. The shim is intentionally separate so this
 * module typechecks and runs (configfs-tsm path) without the binding present.
 */
async function getQuoteViaIoctl(
  devPath: string,
  reportData: Uint8Array,
): Promise<Uint8Array> {
  // Open the device first so a missing/permission error is reported clearly.
  let fd: number;
  try {
    fd = openSync(devPath, "r+");
  } catch (err) {
    throw new Error(
      `TdxAttestation: cannot open ${devPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    const shim = await loadIoctlShim();
    return shim.getQuote(fd, reportData);
  } finally {
    closeSync(fd);
  }
}

interface TdxIoctlShim {
  /** Run TDX_CMD_GET_QUOTE on an open fd, returning the raw DCAP quote bytes. */
  getQuote(fd: number, reportData: Uint8Array): Uint8Array;
}

/**
 * Resolve the optional native ioctl shim. Kept dynamic so the configfs-tsm
 * code path (the GCP TDX VM default) has no hard dependency on a compiled
 * addon. If the shim is unavailable the fallback path fails with an actionable
 * message instead of a module-not-found at import time.
 */
async function loadIoctlShim(): Promise<TdxIoctlShim> {
  try {
    // Indirect specifier so the optional addon is resolved at runtime only —
    // it is not a build/typecheck dependency of this package.
    const specifier = "@antseed/tdx-ioctl";
    const mod = (await import(/* @vite-ignore */ specifier)) as
      Partial<TdxIoctlShim> & { default?: TdxIoctlShim };
    const shim = (mod.default ?? mod) as Partial<TdxIoctlShim>;
    if (typeof shim.getQuote !== "function") {
      throw new Error("shim missing getQuote()");
    }
    return shim as TdxIoctlShim;
  } catch (err) {
    throw new Error(
      "TdxAttestation: /dev/tdx_guest fallback needs the native ioctl shim " +
        "(@antseed/tdx-ioctl). Prefer a configfs-tsm-capable kernel (>=6.7). " +
        `Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readTextBestEffort(p: string): Promise<string | null> {
  try {
    return (await fs.readFile(p, "utf8")).trim();
  } catch {
    return null;
  }
}

/**
 * Read the configfs `outblob`, retrying only while the file is not yet present
 * (ENOENT) — the kernel may materialize it asynchronously after `inblob` is
 * written. A present-but-empty outblob is returned as-is (the caller treats a
 * zero-length quote as a QGS failure). Bounded to ~2s total.
 */
async function readOutblobWithRetry(path: string): Promise<Uint8Array> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      return new Uint8Array(await fs.readFile(path));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" || Date.now() >= deadline) throw err;
      await delay(5);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
