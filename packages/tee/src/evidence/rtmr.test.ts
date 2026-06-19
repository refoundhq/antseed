import { test, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  rtmrExtend,
  replayRtmr,
  rtmrLogAnchored,
  measureDigest,
  findEvent,
  RTMR_LEN,
  RTMR_EVENT,
  type RtmrEvent,
} from "./rtmr.js";

test("rtmrExtend == SHA384(prev || digest)", () => {
  const prev = "00".repeat(RTMR_LEN);
  const digest = "ab".repeat(RTMR_LEN);
  const expected = createHash("sha384")
    .update(Buffer.from(prev, "hex"))
    .update(Buffer.from(digest, "hex"))
    .digest("hex");
  expect(rtmrExtend(prev, digest)).toBe(expected);
});

test("replayRtmr accumulates only the target RTMR's events, in order", () => {
  const d1 = "11".repeat(RTMR_LEN);
  const d2 = "22".repeat(RTMR_LEN);
  const events: RtmrEvent[] = [
    { rtmr: 3, digest: d1, eventType: "a" },
    { rtmr: 2, digest: "ff".repeat(RTMR_LEN), eventType: "other" }, // ignored
    { rtmr: 3, digest: d2, eventType: "b" },
  ];
  const expected = rtmrExtend(rtmrExtend("00".repeat(RTMR_LEN), d1), d2);
  expect(replayRtmr(events, 3)).toBe(expected);
});

test("rtmrLogAnchored matches the quote RTMR and rejects tampering", () => {
  const events: RtmrEvent[] = [
    { rtmr: 3, digest: measureDigest("egress:{...}"), eventType: RTMR_EVENT.egressPolicy },
  ];
  const quoteRtmr = replayRtmr(events, 3);
  expect(rtmrLogAnchored(events, 3, quoteRtmr)).toBe(true);

  const tampered: RtmrEvent[] = [{ ...events[0]!, digest: "cc".repeat(RTMR_LEN) }];
  expect(rtmrLogAnchored(tampered, 3, quoteRtmr)).toBe(false);
  expect(rtmrLogAnchored(events, 3, "de".repeat(RTMR_LEN))).toBe(false);
});

test("findEvent returns the unique typed event; null if absent or ambiguous", () => {
  const e: RtmrEvent = { rtmr: 3, digest: "00".repeat(RTMR_LEN), eventType: RTMR_EVENT.egressPolicy };
  expect(findEvent([e], RTMR_EVENT.egressPolicy)).toBe(e);
  expect(findEvent([], RTMR_EVENT.egressPolicy)).toBe(null);
  expect(findEvent([e, e], RTMR_EVENT.egressPolicy)).toBe(null);
});
