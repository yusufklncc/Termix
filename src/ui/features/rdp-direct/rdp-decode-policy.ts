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
 * Whether a decoded picture could plausibly belong to this surface.
 *
 * A correct frame is the surface size rounded up to a macroblock: never
 * smaller, never more than 15 pixels larger. A hardware decoder that has
 * quietly failed reports a size of its own instead -- measured against a
 * Windows host encoding 1152x1136, where the browser claimed 1280x720 and
 * painted green while ffmpeg decoded the same bytes correctly.
 *
 * A surface of zero is not a judgement either way: nothing is known yet.
 */
export function isForeignFrameSize(
  frame: { width: number; height: number },
  surface: { width: number; height: number },
): boolean {
  if (surface.width <= 0 || surface.height <= 0) return false;

  const alignedWidth = Math.ceil(surface.width / MACROBLOCK) * MACROBLOCK;
  const alignedHeight = Math.ceil(surface.height / MACROBLOCK) * MACROBLOCK;

  return (
    frame.width < surface.width ||
    frame.height < surface.height ||
    frame.width > alignedWidth ||
    frame.height > alignedHeight
  );
}

/**
 * Maps a rectangle in surface coordinates onto the coded picture.
 *
 * A server may encode at one resolution and describe the update in another --
 * the same host encodes 1280x720 for surfaces of 1126x1130 and 1684x1282
 * alike. Where the sizes agree the ratio is one and this is an identity.
 */
export function mapRectToFrame(
  rect: { left: number; top: number; right: number; bottom: number },
  frame: { width: number; height: number },
  surface: { width: number; height: number },
): { sx: number; sy: number; sw: number; sh: number } | null {
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;
  if (width <= 0 || height <= 0) return null;

  const scaleX = surface.width > 0 ? frame.width / surface.width : 1;
  const scaleY = surface.height > 0 ? frame.height / surface.height : 1;

  return {
    sx: rect.left * scaleX,
    sy: rect.top * scaleY,
    sw: width * scaleX,
    sh: height * scaleY,
  };
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
