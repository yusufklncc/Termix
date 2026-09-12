import { describe, expect, it } from "vitest";
import {
  codecFromSps,
  isForeignFrameSize,
  listNalTypes,
  rectHasArea,
  surfaceRegion,
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

  it("accepts the padding two real Windows hosts actually produce", () => {
    // Width aligned to 32, height to 16. Assuming 16 in both directions
    // rejected these and sent both hosts down the slow server-decode path.
    expect(isForeignFrameSize({ width: 1152, height: 1136 }, surface)).toBe(
      false,
    );
    expect(
      isForeignFrameSize(
        { width: 704, height: 1344 },
        { width: 688, height: 1338 },
      ),
    ).toBe(false);
  });

  it("accepts an exact match", () => {
    expect(isForeignFrameSize({ width: 1126, height: 1130 }, surface)).toBe(
      false,
    );
  });

  it("rejects the size a failed decoder invents", () => {
    // Measured: the browser claimed 1280x720 for this surface and painted
    // green. Padding can never make a picture shorter than its surface.
    expect(isForeignFrameSize({ width: 1280, height: 720 }, surface)).toBe(
      true,
    );
  });

  it("rejects a frame smaller than the surface in either dimension", () => {
    expect(isForeignFrameSize({ width: 800, height: 1136 }, surface)).toBe(
      true,
    );
    expect(isForeignFrameSize({ width: 1152, height: 600 }, surface)).toBe(
      true,
    );
  });

  it("rejects a size with no relationship to the surface", () => {
    expect(isForeignFrameSize({ width: 3840, height: 2160 }, surface)).toBe(
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

describe("surfaceRegion", () => {
  it("takes the surface out of a padded picture rather than stretching it", () => {
    // 688x1338 arrives as 704x1344; the extra 16 and 6 pixels are padding and
    // drawing them onto the surface would skew the whole desktop.
    expect(
      surfaceRegion({ width: 704, height: 1344 }, { width: 688, height: 1338 }),
    ).toEqual({ width: 688, height: 1338 });
  });

  it("is an identity when there is no padding", () => {
    expect(
      surfaceRegion({ width: 1600, height: 900 }, { width: 1600, height: 900 }),
    ).toEqual({ width: 1600, height: 900 });
  });

  it("never reads past the picture", () => {
    expect(
      surfaceRegion({ width: 640, height: 480 }, { width: 1600, height: 900 }),
    ).toEqual({ width: 640, height: 480 });
  });

  it("falls back to the picture before the surface is sized", () => {
    expect(
      surfaceRegion({ width: 640, height: 480 }, { width: 0, height: 0 }),
    ).toEqual({ width: 640, height: 480 });
  });
});

describe("rectHasArea", () => {
  it("accepts a rect that covers pixels", () => {
    expect(rectHasArea({ left: 0, top: 0, right: 10, bottom: 10 })).toBe(true);
  });

  it("rejects the empty rects RDP emits", () => {
    expect(rectHasArea({ left: 5, top: 5, right: 5, bottom: 9 })).toBe(false);
    expect(rectHasArea({ left: 5, top: 9, right: 9, bottom: 5 })).toBe(false);
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
