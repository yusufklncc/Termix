import { describe, expect, it } from "vitest";
import {
  codecFromSps,
  isForeignFrameSize,
  listNalTypes,
  mapRectToFrame,
  nextDecoderStage,
} from "../../../features/rdp-direct/rdp-decode-policy";

/** Annex B bitstream from NAL bodies, alternating 4- and 3-byte start codes. */
function annexB(...nals: number[][]): Uint8Array {
  const out: number[] = [];
  nals.forEach((nal, index) => {
    // Both start code lengths occur in a real stream, so both are exercised.
    if (index % 2 === 1) out.push(0, 0, 1);
    else out.push(0, 0, 0, 1);
    out.push(...nal);
  });
  return new Uint8Array(out);
}

describe("listNalTypes", () => {
  it("reads the types of a complete key frame", () => {
    // What a Windows RDP host actually sends: AUD, SPS, PPS, SEI, IDR slices.
    const stream = annexB(
      [0x09, 0x10],
      [0x67, 0x4d, 0x40, 0x20],
      [0x68, 0xee],
      [0x06, 0x00],
      [0x65, 0x88],
      [0x65, 0x88],
    );
    expect(listNalTypes(stream)).toEqual([9, 7, 8, 6, 5, 5]);
  });

  it("reports an empty list rather than guessing at bytes with no start code", () => {
    expect(listNalTypes(new Uint8Array([1, 2, 3, 4, 5]))).toEqual([]);
    expect(listNalTypes(new Uint8Array())).toEqual([]);
  });

  it("does not read past a start code at the very end", () => {
    expect(listNalTypes(new Uint8Array([0, 0, 0, 1]))).toEqual([]);
  });
});

describe("codecFromSps", () => {
  it("builds the codec string from the three bytes after the SPS header", () => {
    // Main profile, level 3.2 -- the stream that broke a hardcoded baseline
    // configuration without reporting anything.
    const stream = annexB([0x67, 0x4d, 0x40, 0x20], [0x65, 0x88]);
    expect(codecFromSps(stream)).toBe("avc1.4d4020");
  });

  it("pads single-digit bytes, which a naive hex conversion drops", () => {
    const stream = annexB([0x67, 0x42, 0x00, 0x0a]);
    expect(codecFromSps(stream)).toBe("avc1.42000a");
  });

  it("finds the SPS behind other NAL units", () => {
    const stream = annexB(
      [0x09, 0x10],
      [0x06, 0x00],
      [0x67, 0x64, 0x00, 0x28],
      [0x65, 0x88],
    );
    expect(codecFromSps(stream)).toBe("avc1.640028");
  });

  it("returns null when there is no SPS, so configuration waits", () => {
    // A delta frame carries slices alone; configuring from it is impossible.
    expect(codecFromSps(annexB([0x41, 0x9a], [0x41, 0x9a]))).toBeNull();
  });

  it("returns null for a truncated SPS rather than reading past it", () => {
    expect(codecFromSps(new Uint8Array([0, 0, 0, 1, 0x67, 0x4d]))).toBeNull();
  });
});

describe("isForeignFrameSize", () => {
  const surface = { width: 1126, height: 1130 };

  it("accepts the macroblock-aligned size of the surface", () => {
    // 1126 -> 1136, 1130 -> 1136. This is what a correct decoder returns.
    expect(
      isForeignFrameSize({ width: 1136, height: 1136 }, surface),
    ).toBe(false);
  });

  it("accepts an exact match", () => {
    expect(isForeignFrameSize({ width: 1126, height: 1130 }, surface)).toBe(
      false,
    );
  });

  it("rejects the size a failed hardware decoder invents", () => {
    // Measured: the browser claimed 1280x720 for this surface and painted
    // green, while ffmpeg decoded the same bytes as 1152x1136.
    expect(isForeignFrameSize({ width: 1280, height: 720 }, surface)).toBe(true);
  });

  it("rejects a frame smaller than the surface", () => {
    expect(isForeignFrameSize({ width: 800, height: 600 }, surface)).toBe(true);
  });

  it("rejects a frame more than a macroblock larger", () => {
    expect(isForeignFrameSize({ width: 1152, height: 1136 }, surface)).toBe(
      true,
    );
  });

  it("judges nothing before the surface size is known", () => {
    // A canvas that has not been sized yet would otherwise reject every frame
    // and trip the fallback before the session has started.
    expect(
      isForeignFrameSize({ width: 1280, height: 720 }, { width: 0, height: 0 }),
    ).toBe(false);
  });
});

describe("mapRectToFrame", () => {
  it("is an identity when the picture is the surface size", () => {
    expect(
      mapRectToFrame(
        { left: 10, top: 20, right: 110, bottom: 220 },
        { width: 1600, height: 900 },
        { width: 1600, height: 900 },
      ),
    ).toEqual({ sx: 10, sy: 20, sw: 100, sh: 200 });
  });

  it("scales when the server encodes at another resolution", () => {
    expect(
      mapRectToFrame(
        { left: 0, top: 0, right: 800, bottom: 450 },
        { width: 1280, height: 720 },
        { width: 1600, height: 900 },
      ),
    ).toEqual({ sx: 0, sy: 0, sw: 640, sh: 360 });
  });

  it("skips a rect with no area rather than drawing nothing at a cost", () => {
    const frame = { width: 100, height: 100 };
    expect(
      mapRectToFrame({ left: 5, top: 5, right: 5, bottom: 9 }, frame, frame),
    ).toBeNull();
    expect(
      mapRectToFrame({ left: 5, top: 9, right: 9, bottom: 5 }, frame, frame),
    ).toBeNull();
  });
});

describe("nextDecoderStage", () => {
  it("tries software before giving up, and gives up after that", () => {
    expect(nextDecoderStage("hardware")).toBe("software");
    expect(nextDecoderStage("software")).toBe("given-up");
  });

  it("stays given up, so a failing stream cannot loop between decoders", () => {
    expect(nextDecoderStage("given-up")).toBe("given-up");
  });
});
