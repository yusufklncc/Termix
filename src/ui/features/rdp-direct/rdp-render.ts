import { readHelo, type RdpFrame } from "./rdp-wire.ts";

/**
 * The half of the session that is only pictures.
 *
 * A live session is this plus input, acknowledgements and a clipboard; a
 * recording is only this. Keeping the visual frames in one place is what stops
 * the two drifting -- a new kind of frame added for the live path would
 * otherwise be silently ignored on playback, and the bug would look like a
 * recording that renders differently from the session it recorded.
 */

export interface RdpRenderSurface {
  /** Where the CSS cursor is set. Playback passes its own container. */
  style: { cursor: string };
}

export interface RdpRenderer {
  /** Handles a frame if it is a visual one. Returns whether it did. */
  handle(frame: RdpFrame): boolean;
}

export function createRdpRenderer({
  worker,
  surface,
  onResize,
}: {
  worker: Worker;
  surface: RdpRenderSurface;
  onResize?: (width: number, height: number) => void;
}): RdpRenderer {
  // Reused across cursor updates: a cursor arrives many times a second while
  // moving over different shapes, and a canvas per update is a canvas per
  // update to garbage collect.
  const cursorCanvas = document.createElement("canvas");

  const applyCursor = (payload: Uint8Array) => {
    if (payload.length < 8) return;
    const view = new DataView(
      payload.buffer,
      payload.byteOffset,
      payload.length,
    );
    const width = view.getUint16(0, true);
    const height = view.getUint16(2, true);
    const hotX = view.getUint16(4, true);
    const hotY = view.getUint16(6, true);

    // A zero-sized cursor is how the bridge says "hide it".
    if (width === 0 || height === 0) {
      surface.style.cursor = "none";
      return;
    }
    if (payload.length < 8 + width * height * 4) return;

    const context = cursorCanvas.getContext("2d");
    if (!context) return;
    cursorCanvas.width = width;
    cursorCanvas.height = height;

    const image = context.createImageData(width, height);
    // BGRA on the wire, RGBA in an ImageData.
    for (let i = 0; i < width * height; i++) {
      const src = 8 + i * 4;
      const dst = i * 4;
      image.data[dst] = payload[src + 2];
      image.data[dst + 1] = payload[src + 1];
      image.data[dst + 2] = payload[src];
      image.data[dst + 3] = payload[src + 3];
    }
    context.putImageData(image, 0, 0);

    try {
      // The keyword fallback matters: a browser that rejects the image (too
      // large, or a hotspot outside it) drops the whole declaration otherwise.
      const url = cursorCanvas.toDataURL("image/png");
      surface.style.cursor = `url(${url}) ${hotX} ${hotY}, default`;
    } catch {
      surface.style.cursor = "default";
    }
  };

  /** Hands a payload to the worker without copying it. */
  const transfer = (type: string, payload: Uint8Array) => {
    const buffer = payload.buffer.slice(
      payload.byteOffset,
      payload.byteOffset + payload.length,
    );
    worker.postMessage({ type, payload: buffer }, [buffer]);
  };

  return {
    handle(frame: RdpFrame): boolean {
      switch (frame.magic) {
        case "HELO": {
          const size = readHelo(frame.payload);
          if (!size) return true;
          worker.postMessage({ type: "resize", ...size });
          onResize?.(size.width, size.height);
          return true;
        }

        case "AVCF":
          transfer("avc", frame.payload);
          return true;

        case "RECT":
          transfer("rect", frame.payload);
          return true;

        case "RECW":
          transfer("rectw", frame.payload);
          return true;

        case "CURS":
          applyCursor(frame.payload);
          return true;

        case "CURD":
          surface.style.cursor = "default";
          return true;

        default:
          return false;
      }
    },
  };
}
