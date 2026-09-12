/**
 * The decisions the decoder worker makes, separated from the decoder itself.
 *
 * Every one of these was a bug first. A browser decoder fails by accepting
 * frames and quietly producing nothing, or a blank picture at a size it
 * invented, so the worker has to reason about what it is being handed rather
 * than trust it -- and that reasoning is exactly what a worker full of
 * WebCodecs and canvas calls makes impossible to test.
 */

/** H.264 NAL unit types worth naming. */
export const NAL_SPS = 7;
export const NAL_IDR = 5;

/** RDP aligns a desktop to macroblocks, so a coded frame is a multiple of 16. */
export const MACROBLOCK = 16;

/**
 * Lists the NAL unit types in an Annex B bitstream, in order.
 *
 * A decoder cannot start without a sequence parameter set (7) and a picture
 * parameter set (8); an IDR (5) on its own is undecodable, and some decoders
 * drop it in silence rather than reporting an error. Seeing the actual list is
 * what separates "the stream is wrong" from "the decoder is wrong".
 */
export function listNalTypes(bitstream: Uint8Array): number[] {
  const types: number[] = [];
  for (let i = 0; i + 3 < bitstream.length; i++) {
    const start3 =
      bitstream[i] === 0 && bitstream[i + 1] === 0 && bitstream[i + 2] === 1;
    const start4 =
      bitstream[i] === 0 &&
      bitstream[i + 1] === 0 &&
      bitstream[i + 2] === 0 &&
      bitstream[i + 3] === 1;
    if (!start3 && !start4) continue;

    const at = i + (start4 ? 4 : 3);
    if (at >= bitstream.length) break;
    types.push(bitstream[at] & 0x1f);
    i = at;
  }
  return types;
}

/**
 * Builds a WebCodecs codec string from the stream's own sequence parameter set.
 *
 * A hardcoded profile is a guess about someone else's encoder, and a wrong one
 * fails in the worst possible way: the browser accepts the configuration, then
 * accepts frames and emits neither a picture nor an error. The three bytes
 * after the SPS NAL header are exactly what the codec string encodes --
 * profile, constraint flags, level -- so they are read rather than assumed.
 *
 * Returns null when the bitstream carries no SPS, which means configuration
 * has to wait for a frame that does.
 */
export function codecFromSps(bitstream: Uint8Array): string | null {
  for (let i = 0; i + 3 < bitstream.length; i++) {
    const start3 =
      bitstream[i] === 0 && bitstream[i + 1] === 0 && bitstream[i + 2] === 1;
    const start4 =
      bitstream[i] === 0 &&
      bitstream[i + 1] === 0 &&
      bitstream[i + 2] === 0 &&
      bitstream[i + 3] === 1;
    if (!start3 && !start4) continue;

    const at = i + (start4 ? 4 : 3);
    if (at + 3 >= bitstream.length) break;
    if ((bitstream[at] & 0x1f) !== NAL_SPS) {
      i = at;
      continue;
    }

    const hex = (value: number) => value.toString(16).padStart(2, "0");
    return `avc1.${hex(bitstream[at + 1])}${hex(bitstream[at + 2])}${hex(
      bitstream[at + 3],
    )}`;
  }
  return null;
}

/**
 * How much larger than the surface a coded picture may legitimately be.
 *
 * An encoder pads to whole macroblocks, and not only to 16: measured against
 * two unrelated Windows hosts, the width is aligned to 32 while the height is
 * aligned to 16 -- a 688x1338 surface arrives as 704x1344, a 1126x1130 one as
 * 1152x1136. Assuming 16 in both directions rejects perfectly good frames.
 *
 * So the bound is deliberately loose. It is not here to validate padding; it
 * is here to catch a decoder that has invented a size, and those are not
 * subtly wrong.
 */
const MAX_PADDING_RATIO = 1.25;

/**
 * Whether a decoded picture could plausibly belong to this surface.
 *
 * A correct frame covers the surface and is padded up to whole macroblocks. A
 * decoder that has quietly failed reports a size of its own instead and paints
 * a blank picture at it -- measured against a host encoding 1152x1136, where
 * the browser claimed 1280x720 while ffmpeg decoded the same bytes correctly.
 *
 * That case is caught by the picture being *smaller* than the surface, which is
 * something padding can never make it. The upper bound only rules out a size
 * with no relationship to the surface at all.
 *
 * A surface of zero is not a judgement either way: nothing is known yet.
 */
export function isForeignFrameSize(
  frame: { width: number; height: number },
  surface: { width: number; height: number },
): boolean {
  if (surface.width <= 0 || surface.height <= 0) return false;

  return (
    frame.width < surface.width ||
    frame.height < surface.height ||
    frame.width > surface.width * MAX_PADDING_RATIO ||
    frame.height > surface.height * MAX_PADDING_RATIO
  );
}

/**
 * The region of a coded picture that is the surface.
 *
 * An encoder pads to whole macroblocks, and that padding sits to the right and
 * below -- it is not a scaled version of the desktop. Drawing the whole picture
 * onto the surface would stretch it by a few pixels; taking the top-left
 * surface-sized region is exact.
 */
export function surfaceRegion(
  frame: { width: number; height: number },
  surface: { width: number; height: number },
): { width: number; height: number } {
  return {
    width: Math.min(frame.width, surface.width || frame.width),
    height: Math.min(frame.height, surface.height || frame.height),
  };
}

/**
 * Whether a rect covers any pixels at all.
 *
 * A zero-area rect costs a draw call and changes nothing; RDP emits them.
 */
export function rectHasArea(rect: {
  left: number;
  top: number;
  right: number;
  bottom: number;
}): boolean {
  return rect.right > rect.left && rect.bottom > rect.top;
}

export type DecoderStage = "hardware" | "software" | "given-up";

/**
 * What to do when a decoder hands back a picture that cannot be from this
 * stream.
 *
 * Hardware first, because decoding in software is the cost this whole path
 * exists to avoid. Software second, because the failure is usually the
 * hardware path rather than the browser. Then stop: two failures in a row mean
 * this browser cannot decode this stream, and the bridge can decode it instead.
 */
export function nextDecoderStage(stage: DecoderStage): DecoderStage {
  if (stage === "hardware") return "software";
  return "given-up";
}

/**
 * The geometry at the head of a painted region, or null if it cannot be one.
 *
 * The pixels that follow may be deflated, so the length of the message says
 * nothing about whether the region is whole -- only the uncompressed case can
 * be checked here, and it is, because a short buffer would otherwise reach
 * ImageData as a range error mid-paint.
 */
export function parseRectHeader(
  view: DataView,
  byteLength: number,
  deflated: boolean,
): { left: number; top: number; width: number; height: number } | null {
  if (byteLength < RECT_HEADER_BYTES) return null;

  const left = view.getUint16(2, true);
  const top = view.getUint16(4, true);
  const width = view.getUint16(6, true);
  const height = view.getUint16(8, true);
  if (width === 0 || height === 0) return null;

  if (
    !deflated &&
    byteLength < RECT_HEADER_BYTES + width * height * BYTES_PER_PIXEL
  ) {
    return null;
  }

  return { left, top, width, height };
}

/** surfaceId, left, top, width, height -- five u16s ahead of the pixels. */
export const RECT_HEADER_BYTES = 10;
export const BYTES_PER_PIXEL = 4;
