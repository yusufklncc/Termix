import { describe, expect, it } from "vitest";
import {
  encodeRdpFrame,
  isKeyFrame,
  parseAvcFrame,
  readFrameId,
  readHelo,
  RdpFrameReader,
} from "../../../features/rdp-direct/rdp-wire";

function frame(magic: string, payload: number[]): Uint8Array {
  return encodeRdpFrame(magic, new Uint8Array(payload));
}

describe("RdpFrameReader", () => {
  it("reads a whole frame", () => {
    const reader = new RdpFrameReader();
    const frames = reader.push(frame("HELO", [1, 2, 3, 4]));
    expect(frames).toHaveLength(1);
    expect(frames[0].magic).toBe("HELO");
    expect(Array.from(frames[0].payload)).toEqual([1, 2, 3, 4]);
  });

  it("reads several frames out of one chunk", () => {
    const reader = new RdpFrameReader();
    const combined = new Uint8Array([
      ...frame("FBEG", [1, 0, 0, 0]),
      ...frame("FEND", [1, 0, 0, 0]),
    ]);
    const frames = reader.push(combined);
    expect(frames.map((f) => f.magic)).toEqual(["FBEG", "FEND"]);
  });

  it("carries a split frame across chunks", () => {
    const reader = new RdpFrameReader();
    const whole = frame("AVCF", [9, 9, 9, 9, 9, 9]);

    // A websocket message can end anywhere, including mid-header.
    expect(reader.push(whole.subarray(0, 5))).toHaveLength(0);
    expect(reader.push(whole.subarray(5, 10))).toHaveLength(0);
    const frames = reader.push(whole.subarray(10));
    expect(frames).toHaveLength(1);
    expect(Array.from(frames[0].payload)).toEqual([9, 9, 9, 9, 9, 9]);
  });

  it("keeps a trailing partial frame for the next chunk", () => {
    const reader = new RdpFrameReader();
    const combined = new Uint8Array([
      ...frame("FBEG", [1, 0, 0, 0]),
      ...frame("FEND", [2, 0, 0, 0]).subarray(0, 6),
    ]);
    expect(reader.push(combined).map((f) => f.magic)).toEqual(["FBEG"]);
    const rest = frame("FEND", [2, 0, 0, 0]).subarray(6);
    expect(reader.push(rest).map((f) => f.magic)).toEqual(["FEND"]);
  });

  it("handles a zero-length payload", () => {
    const reader = new RdpFrameReader();
    const frames = reader.push(frame("BYE ", []));
    expect(frames).toHaveLength(1);
    expect(frames[0].payload).toHaveLength(0);
  });
});

describe("parseAvcFrame", () => {
  it("splits the header, rects and bitstream", () => {
    const payload = new Uint8Array(12 + 8 + 3);
    const view = new DataView(payload.buffer);
    view.setUint16(0, 7, true); // surfaceId
    view.setUint16(2, 10, true); // left
    view.setUint16(4, 20, true); // top
    view.setUint16(6, 110, true); // right
    view.setUint16(8, 220, true); // bottom
    view.setUint16(10, 1, true); // numRects
    view.setUint16(12, 1, true);
    view.setUint16(14, 2, true);
    view.setUint16(16, 3, true);
    view.setUint16(18, 4, true);
    payload.set([0xaa, 0xbb, 0xcc], 20);

    const parsed = parseAvcFrame(payload);
    expect(parsed).not.toBeNull();
    expect(parsed!.surfaceId).toBe(7);
    expect(parsed!.dest).toEqual({
      left: 10,
      top: 20,
      right: 110,
      bottom: 220,
    });
    expect(parsed!.rects).toEqual([{ left: 1, top: 2, right: 3, bottom: 4 }]);
    expect(Array.from(parsed!.bitstream)).toEqual([0xaa, 0xbb, 0xcc]);
  });

  it("returns null for a truncated payload rather than reading past it", () => {
    expect(parseAvcFrame(new Uint8Array(4))).toBeNull();

    const claimsTwoRects = new Uint8Array(12);
    new DataView(claimsTwoRects.buffer).setUint16(10, 2, true);
    expect(parseAvcFrame(claimsTwoRects)).toBeNull();
  });
});

describe("isKeyFrame", () => {
  it("finds an IDR behind a 4-byte start code", () => {
    expect(isKeyFrame(new Uint8Array([0, 0, 0, 1, 0x65, 0x88]))).toBe(true);
  });

  it("finds an SPS, which is also a decoder entry point", () => {
    expect(isKeyFrame(new Uint8Array([0, 0, 1, 0x67, 0x42]))).toBe(true);
  });

  it("reports a P slice as a delta", () => {
    expect(isKeyFrame(new Uint8Array([0, 0, 0, 1, 0x41, 0x9a]))).toBe(false);
  });

  it("does not crash on bytes with no start code", () => {
    expect(isKeyFrame(new Uint8Array([1, 2, 3, 4, 5]))).toBe(false);
    expect(isKeyFrame(new Uint8Array())).toBe(false);
  });
});

describe("readHelo and readFrameId", () => {
  it("reads the desktop size", () => {
    const payload = new Uint8Array(8);
    const view = new DataView(payload.buffer);
    view.setUint32(0, 1920, true);
    view.setUint32(4, 1080, true);
    expect(readHelo(payload)).toEqual({ width: 1920, height: 1080 });
  });

  it("reads a frame id", () => {
    const payload = new Uint8Array(4);
    new DataView(payload.buffer).setUint32(0, 42, true);
    expect(readFrameId(payload)).toBe(42);
  });

  it("returns null when the payload is too short", () => {
    expect(readHelo(new Uint8Array(4))).toBeNull();
    expect(readFrameId(new Uint8Array(2))).toBeNull();
  });
});
