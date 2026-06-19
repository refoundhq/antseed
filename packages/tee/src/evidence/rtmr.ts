import { createHash } from "node:crypto";

/**
 * TDX RTMR measured-log replay — the primitive that turns a *declared* runtime
 * policy into a *measured* one (Tier B → Tier A, see COMPLIANCE.md).
 *
 * A measured launcher applies an enforcer (nftables egress allowlist, tmpfs-only
 * writable state, …), drops the capability that could undo it, then **extends a
 * TDX RTMR** with the policy's digest before generating the quote. The evidence
 * carries the ordered event log; the buyer REPLAYS it and checks the result equals
 * the RTMR value inside the genuine quote. Match ⇒ the hardware measured exactly
 * this policy — not a self-report. Each RTMR is `SHA-384(prev || digest)`.
 */

/** SHA-384 width in bytes — the TDX RTMR/extend size. */
export const RTMR_LEN = 48;

/** Canonical AntSeed RTMR event type tags. */
export const RTMR_EVENT = {
  egressPolicy: "antseed.egress-policy",
  storagePolicy: "antseed.storage-policy",
  imaAggregate: "antseed.ima-aggregate",
  binaryDigest: "antseed.binary-digest",
} as const;

/** One measured event extended into an RTMR (a TDX runtime measurement register). */
export interface RtmrEvent {
  /** Which RTMR this event extended (0-3). AntSeed launcher policy events use 3 (runtime). */
  rtmr: number;
  /** The 48-byte SHA-384 digest extended (hex). `RTMR_new = SHA384(RTMR_old || digest)`. */
  digest: string;
  /** Event type tag (see {@link RTMR_EVENT}). */
  eventType: string;
  /** Optional human description. */
  description?: string;
}

function normHex(h: string): string {
  return h.toLowerCase().replace(/^0x/, "");
}

/** Extend an RTMR value (hex) with a digest (hex): `SHA384(rtmr || digest)`. */
export function rtmrExtend(rtmrHex: string, digestHex: string): string {
  return createHash("sha384")
    .update(Buffer.from(normHex(rtmrHex), "hex"))
    .update(Buffer.from(normHex(digestHex), "hex"))
    .digest("hex");
}

/** SHA-384 of the canonical bytes a policy/event is measured under. */
export function measureDigest(canonical: string | Uint8Array): string {
  return createHash("sha384").update(canonical).digest("hex");
}

/**
 * Replay the events targeting `rtmrIndex` from a starting value (default all-zero —
 * the TDX boot value for the runtime RTMRs the OS extends) and return the final
 * RTMR (hex). Events for other RTMR indices are skipped; order is preserved.
 */
export function replayRtmr(events: RtmrEvent[], rtmrIndex: number, startHex?: string): string {
  let acc = startHex ? normHex(startHex) : "00".repeat(RTMR_LEN);
  for (const e of events) {
    if (e.rtmr !== rtmrIndex) continue;
    acc = rtmrExtend(acc, e.digest);
  }
  return acc;
}

/**
 * True iff replaying `events` for `rtmrIndex` yields `expectedRtmrHex` (the value
 * read from the genuine quote). This is the anchor check: a log that does not
 * replay to the hardware RTMR is rejected — it is not measured.
 */
export function rtmrLogAnchored(
  events: RtmrEvent[],
  rtmrIndex: number,
  expectedRtmrHex: string,
  startHex?: string,
): boolean {
  if (!expectedRtmrHex) return false;
  return replayRtmr(events, rtmrIndex, startHex) === normHex(expectedRtmrHex);
}

/**
 * Find the single event of `eventType` in the log, or null. Returns null if more
 * than one is present (an ambiguous log is not trusted for a typed lookup).
 */
export function findEvent(events: RtmrEvent[], eventType: string): RtmrEvent | null {
  const matches = events.filter((e) => e.eventType === eventType);
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * One IMA (Integrity Measurement Architecture) measurement-log entry: an
 * executable/file the kernel measured before it ran. `hash` is the content hash —
 * it is BOTH extended into the IMA RTMR (so the log is hardware-anchored) AND
 * checked against the approved known-binary allowlist. (Model simplification: real
 * IMA extends a template hash that also covers the path; here the content hash is
 * the extended value, which faithfully commits the RTMR to the ordered multiset of
 * approved contents.)
 */
export interface ImaEntry {
  /** Hex content hash of the measured executable/file. */
  hash: string;
  /** Hash algorithm (e.g. "sha256" / "sha384"). Informational. */
  alg?: string;
  /** Path / event name (informational). */
  path?: string;
}

/** Convert an IMA log into RTMR events on `rtmrIndex` for replay/anchoring. */
export function imaLogToEvents(entries: ImaEntry[], rtmrIndex: number): RtmrEvent[] {
  return entries.map((e) => ({
    rtmr: rtmrIndex,
    digest: e.hash,
    eventType: "antseed.ima-entry",
    ...(e.path ? { description: e.path } : {}),
  }));
}
