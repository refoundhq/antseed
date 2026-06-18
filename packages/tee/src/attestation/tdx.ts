import { promises as fs } from "node:fs";
import { packReportData } from "../report-data.js";
import type {
  AttestationProvider,
  AttestationQuote,
  ReportDataBindings,
} from "./types.js";

/**
 * Intel TDX attestation via the in-kernel `configfs-tsm` report interface
 * (preferred) with a `tdx_guest` sysfs fallback.
 *
 * configfs-tsm flow (kernel >= 6.7):
 *   1. mkdir a report node:   /sys/kernel/config/tsm/report/<name>
 *   2. write the 64-byte report_data to  <name>/inblob
 *   3. read the raw quote from            <name>/outblob
 *   4. (optionally) read provider/generation/auxblob for collateral
 *   5. rmdir <name>
 *
 * tdx_guest fallback (older kernels): ioctl(TDX_CMD_GET_REPORT0) on
 *   /dev/tdx_guest then a quote-generation service. Marked as a TODO below.
 *
 * This file gets the interface and sysfs paths right. The DCAP quote *parsing*
 * (extracting MRTD/RTMRs and the report_data field at td_report[520:584]) and
 * DCAP *verification* (vendor PKI / TCB) are the verifier's job — see
 * verifier/checks.ts. Quote *generation* here is local-only and makes no
 * network call.
 */

const CONFIGFS_TSM_DIR = "/sys/kernel/config/tsm/report";
const TDX_GUEST_DEV = "/dev/tdx_guest";

export class TdxAttestation implements AttestationProvider {
  readonly platform = "tdx" as const;

  async isAvailable(): Promise<boolean> {
    // Present if either the configfs-tsm report dir or the tdx_guest device exists.
    const configfs = await pathExists(CONFIGFS_TSM_DIR);
    if (configfs) return true;
    return pathExists(TDX_GUEST_DEV);
  }

  async generateQuote(bindings: ReportDataBindings): Promise<AttestationQuote> {
    const reportData = packReportData(bindings); // 64 bytes

    if (await pathExists(CONFIGFS_TSM_DIR)) {
      return this.quoteViaConfigfsTsm(reportData);
    }
    if (await pathExists(TDX_GUEST_DEV)) {
      return this.quoteViaTdxGuest(reportData);
    }
    throw new Error(
      "TdxAttestation.generateQuote: no TDX interface found " +
        `(${CONFIGFS_TSM_DIR} or ${TDX_GUEST_DEV}). Not running under Intel TDX?`,
    );
  }

  /**
   * configfs-tsm path. Writes report_data to inblob, reads the raw quote from
   * outblob. The node directory is created under a unique name and removed after.
   */
  private async quoteViaConfigfsTsm(
    reportData: Uint8Array,
  ): Promise<AttestationQuote> {
    const name = `antseed-${process.pid}-${Date.now()}`;
    const dir = `${CONFIGFS_TSM_DIR}/${name}`;
    await fs.mkdir(dir);
    try {
      await fs.writeFile(`${dir}/inblob`, reportData);
      const quote = new Uint8Array(await fs.readFile(`${dir}/outblob`));

      // TODO(tee): parse the TDX quote/td_report to populate measurement
      // registers (MRTD, RTMR0..RTMR3). For now they are read from a best-effort
      // sibling node if present; the verifier is the authority on parsing.
      const measurements = await this.readMeasurementsBestEffort(dir);

      return { platform: "tdx", quote, reportData, measurements };
    } finally {
      await fs.rmdir(dir).catch(() => {
        /* node may already be gone */
      });
    }
  }

  private async quoteViaTdxGuest(
    _reportData: Uint8Array,
  ): Promise<AttestationQuote> {
    // TODO(tee): implement the legacy /dev/tdx_guest path:
    //   ioctl(fd, TDX_CMD_GET_REPORT0, { reportdata, tdreport }) to get a
    //   TDREPORT, then hand the TDREPORT to a local quote-generation service
    //   (qgs vsock) to obtain the DCAP quote. Requires a native ioctl binding.
    throw new Error(
      "TdxAttestation: /dev/tdx_guest fallback not yet implemented " +
        "(requires native ioctl binding). Use a configfs-tsm-capable kernel.",
    );
  }

  /**
   * TDX measurement registers are derivable from the quote/td_report. Until the
   * quote parser lands, attempt to read them from any provider-exposed sibling
   * files; return whatever is available (the verifier validates the quote bytes
   * directly regardless).
   */
  private async readMeasurementsBestEffort(
    dir: string,
  ): Promise<Record<string, string>> {
    const measurements: Record<string, string> = {};
    for (const reg of ["mrtd", "rtmr0", "rtmr1", "rtmr2", "rtmr3"]) {
      try {
        const buf = await fs.readFile(`${dir}/${reg}`);
        measurements[reg] = Buffer.from(buf).toString("hex");
      } catch {
        // Not exposed via configfs; the verifier extracts it from the quote.
      }
    }
    return measurements;
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
