/**
 * Wire format shared with the FreeRDP bridge.
 *
 * See docker/freerdp-bridge/WIRE_FORMAT.md. Frames are a 4-byte ASCII magic,
 * a little-endian u32 length, then the payload. Termix relays them untouched,
 * so what the bridge writes is what arrives here.
 */

export interface RdpRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface RdpFrame {
  magic: string;
  payload: Uint8Array;
}

export interface AvcFrame {
  surfaceId: number;
  dest: RdpRect;
  rects: RdpRect[];
  /** Untouched AVC420 bitstream, ready for a WebCodecs decoder. */
  bitstream: Uint8Array;
}

export const RDP_FRAME_HEADER_BYTES = 8;

/**
 * Pulls whole frames out of a byte stream.
 *
 * A WebSocket message is not guaranteed to align with a frame boundary, so the
 * remainder is carried into the next call rather than assumed away.
 */
export class RdpFrameReader {
  private buffer = new Uint8Array(0);

  push(chunk: Uint8Array): RdpFrame[] {
    const combined = new Uint8Array(this.buffer.length + chunk.length);
    combined.set(this.buffer, 0);
    combined.set(chunk, this.buffer.length);

    const frames: RdpFrame[] = [];
    let offset = 0;

    while (combined.length - offset >= RDP_FRAME_HEADER_BYTES) {
      const view = new DataView(
        combined.buffer,
        combined.byteOffset + offset,
        RDP_FRAME_HEADER_BYTES,
      );
      const length = view.getUint32(4, true);
      const total = RDP_FRAME_HEADER_BYTES + length;
      if (combined.length - offset < total) break;

      const magic = String.fromCharCode(
        combined[offset],
        combined[offset + 1],
        combined[offset + 2],
        combined[offset + 3],
      );
      frames.push({
        magic,
        payload: combined.slice(
          offset + RDP_FRAME_HEADER_BYTES,
          offset + total,
        ),
      });
      offset += total;
    }

    this.buffer = combined.slice(offset);
    return frames;
  }

  reset(): void {
    this.buffer = new Uint8Array(0);
  }
}

/**
 * Returns Uint8Array<ArrayBuffer> rather than the default Uint8Array, whose
 * buffer could be a SharedArrayBuffer -- WebSocket.send does not accept that.
 */
export function encodeRdpFrame(
  magic: string,
  payload: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(
    new ArrayBuffer(RDP_FRAME_HEADER_BYTES + payload.length),
  );
  for (let i = 0; i < 4; i++) out[i] = magic.charCodeAt(i);
  new DataView(out.buffer).setUint32(4, payload.length, true);
  out.set(payload, RDP_FRAME_HEADER_BYTES);
  return out;
}

export function parseAvcFrame(payload: Uint8Array): AvcFrame | null {
  if (payload.length < 12) return null;

  const view = new DataView(payload.buffer, payload.byteOffset, payload.length);
  const surfaceId = view.getUint16(0, true);
  const dest: RdpRect = {
    left: view.getUint16(2, true),
    top: view.getUint16(4, true),
    right: view.getUint16(6, true),
    bottom: view.getUint16(8, true),
  };
  const numRects = view.getUint16(10, true);

  const rectsEnd = 12 + numRects * 8;
  if (payload.length < rectsEnd) return null;

  const rects: RdpRect[] = [];
  for (let i = 0; i < numRects; i++) {
    const base = 12 + i * 8;
    rects.push({
      left: view.getUint16(base, true),
      top: view.getUint16(base + 2, true),
      right: view.getUint16(base + 4, true),
      bottom: view.getUint16(base + 6, true),
    });
  }

  return {
    surfaceId,
    dest,
    rects,
    bitstream: payload.subarray(rectsEnd),
  };
}

/**
 * Whether an Annex B bitstream carries an IDR, which is what WebCodecs means
 * by a key chunk. Feeding a delta chunk to a decoder that has not seen a key
 * frame makes it error out, so this decides the chunk type.
 */
export function isKeyFrame(bitstream: Uint8Array): boolean {
  for (let i = 0; i + 3 < bitstream.length; i++) {
    const isStart3 =
      bitstream[i] === 0 && bitstream[i + 1] === 0 && bitstream[i + 2] === 1;
    const isStart4 =
      bitstream[i] === 0 &&
      bitstream[i + 1] === 0 &&
      bitstream[i + 2] === 0 &&
      bitstream[i + 3] === 1;
    if (!isStart3 && !isStart4) continue;

    const nalIndex = i + (isStart4 ? 4 : 3);
    if (nalIndex >= bitstream.length) break;
    const nalType = bitstream[nalIndex] & 0x1f;
    // 5 = IDR slice, 7 = SPS. Either means the decoder can start here.
    if (nalType === 5 || nalType === 7) return true;
    i = nalIndex;
  }
  return false;
}

export function readHelo(payload: Uint8Array): {
  width: number;
  height: number;
} | null {
  if (payload.length < 8) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.length);
  return { width: view.getUint32(0, true), height: view.getUint32(4, true) };
}

export function readFrameId(payload: Uint8Array): number | null {
  if (payload.length < 4) return null;
  return new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.length,
  ).getUint32(0, true);
}
