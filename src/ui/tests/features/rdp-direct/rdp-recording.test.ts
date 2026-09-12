import { describe, expect, it } from "vitest";
import {
  parseRecording,
  readRecordingHeader,
  recordingDuration,
  recordsBetween,
} from "@/features/rdp-direct/rdp-recording.ts";

function build(
  records: Array<{ millis: number; bytes: number[] }>,
  { magic = "TXRD", version = 1 }: { magic?: string; version?: number } = {},
): Uint8Array {
  const body = records.reduce((total, r) => total + 8 + r.bytes.length, 0);
  const out = new Uint8Array(8 + body);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = magic.charCodeAt(i);
  view.setUint32(4, version, true);

  let at = 8;
  for (const record of records) {
    view.setUint32(at, record.millis, true);
    view.setUint32(at + 4, record.bytes.length, true);
    out.set(record.bytes, at + 8);
    at += 8 + record.bytes.length;
  }
  return out;
}

describe("readRecordingHeader", () => {
  it("accepts one of ours", () => {
    expect(readRecordingHeader(build([]))).toBe(8);
  });

  it("refuses another format rather than rendering noise", () => {
    // A guacamole recording opened in this player would otherwise be parsed
    // as lengths and paint garbage.
    expect(readRecordingHeader(build([], { magic: "GUAC" }))).toBeNull();
  });

  it("refuses a version it does not know", () => {
    expect(readRecordingHeader(build([], { version: 2 }))).toBeNull();
  });

  it("refuses a file too short to hold a header", () => {
    expect(readRecordingHeader(new Uint8Array(4))).toBeNull();
  });
});

describe("parseRecording", () => {
  it("reads the records in order", () => {
    const records = parseRecording(
      build([
        { millis: 0, bytes: [1, 2] },
        { millis: 40, bytes: [3] },
      ]),
    );
    expect(records).toHaveLength(2);
    expect(records?.[0].millis).toBe(0);
    expect(Array.from(records![0].bytes)).toEqual([1, 2]);
    expect(records?.[1].millis).toBe(40);
  });

  it("stops at a truncated tail instead of failing", () => {
    // A session that ended when the process did leaves a partial last write,
    // and everything before it is still a recording.
    const whole = build([
      { millis: 0, bytes: [1, 2] },
      { millis: 40, bytes: [3, 4, 5] },
    ]);
    const records = parseRecording(whole.subarray(0, whole.length - 2));
    expect(records).toHaveLength(1);
  });

  it("returns null for a file that is not a recording", () => {
    expect(parseRecording(build([], { magic: "NOPE" }))).toBeNull();
  });
});

describe("recordingDuration", () => {
  it("is when the last chunk arrived", () => {
    expect(
      recordingDuration([
        { millis: 0, bytes: new Uint8Array() },
        { millis: 1200, bytes: new Uint8Array() },
      ]),
    ).toBe(1200);
  });

  it("is zero for an empty recording", () => {
    expect(recordingDuration([])).toBe(0);
  });
});

describe("recordsBetween", () => {
  const records = [0, 10, 20, 30].map((millis) => ({
    millis,
    bytes: new Uint8Array([millis]),
  }));

  it("takes the window half-open, so advancing never repeats a chunk", () => {
    expect(recordsBetween(records, 10, 30).map((r) => r.millis)).toEqual([
      10, 20,
    ]);
  });

  it("takes everything up to a point, which is what seeking needs", () => {
    expect(recordsBetween(records, 0, 25).map((r) => r.millis)).toEqual([
      0, 10, 20,
    ]);
  });

  it("takes nothing from an empty window", () => {
    expect(recordsBetween(records, 15, 15)).toEqual([]);
  });
});
