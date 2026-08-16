/// <reference lib="webworker" />

/**
 * Decode and paint, off the main thread.
 *
 * The H.264 comes off the wire exactly as the RDP server encoded it, so the
 * only thing that touches a pixel in the whole path is the browser's own
 * hardware decoder. Rendering goes to an OffscreenCanvas here rather than the
 * main thread, so a slow frame cannot stall the UI.
 */

import { isKeyFrame, parseAvcFrame, type RdpRect } from "./rdp-wire.ts";

type InboundMessage =
  | { type: "init"; canvas: OffscreenCanvas }
  | { type: "resize"; width: number; height: number }
  | { type: "avc"; payload: ArrayBuffer }
  | { type: "close" };

type OutboundMessage =
  | { type: "ready" }
  | { type: "decoded"; count: number }
  | { type: "error"; message: string };

declare const self: DedicatedWorkerGlobalScope;

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let decoder: VideoDecoder | null = null;
let configured = false;
let decodedCount = 0;

/** Rects for the frame currently in flight, in submission order. */
const pendingRects: RdpRect[][] = [];

function post(message: OutboundMessage) {
  self.postMessage(message);
}

function paint(frame: VideoFrame) {
  const rects = pendingRects.shift();
  if (!ctx) {
    frame.close();
    return;
  }

  try {
    if (!rects || rects.length === 0) {
      ctx.drawImage(frame, 0, 0);
    } else {
      // The picture covers the whole surface; the rects say which parts of it
      // actually changed. Painting only those avoids redrawing stale areas.
      for (const rect of rects) {
        const width = rect.right - rect.left;
        const height = rect.bottom - rect.top;
        if (width <= 0 || height <= 0) continue;
        ctx.drawImage(
          frame,
          rect.left,
          rect.top,
          width,
          height,
          rect.left,
          rect.top,
          width,
          height,
        );
      }
    }
    decodedCount++;
    post({ type: "decoded", count: decodedCount });
  } finally {
    frame.close();
  }
}

function ensureDecoder() {
  if (decoder) return;

  decoder = new VideoDecoder({
    output: paint,
    error: (error) => post({ type: "error", message: String(error) }),
  });
}

async function configureDecoder() {
  if (!decoder || configured) return;

  // No description: that tells WebCodecs the stream is Annex B, which is what
  // the RDP graphics pipeline carries. optimizeForLatency keeps the decoder
  // from buffering frames it could already have shown.
  const config: VideoDecoderConfig = {
    codec: "avc1.42E01E",
    optimizeForLatency: true,
  };

  const support = await VideoDecoder.isConfigSupported(config).catch(
    () => null,
  );
  if (!support?.supported) {
    post({ type: "error", message: "H.264 decoding is not available" });
    return;
  }

  decoder.configure(config);
  configured = true;
}

self.onmessage = async (event: MessageEvent<InboundMessage>) => {
  const message = event.data;

  switch (message.type) {
    case "init": {
      canvas = message.canvas;
      ctx = canvas.getContext("2d");
      ensureDecoder();
      await configureDecoder();
      post({ type: "ready" });
      break;
    }

    case "resize": {
      // Assigning a canvas dimension clears it even when the value is
      // unchanged, so a repeated size must not reach the canvas.
      if (
        canvas &&
        (canvas.width !== message.width || canvas.height !== message.height)
      ) {
        canvas.width = message.width;
        canvas.height = message.height;
      }
      break;
    }

    case "avc": {
      const parsed = parseAvcFrame(new Uint8Array(message.payload));
      if (!parsed || parsed.bitstream.length === 0) return;
      if (!decoder || decoder.state !== "configured") return;

      const key = isKeyFrame(parsed.bitstream);
      // Until a key frame arrives the decoder has no reference to build on, so
      // delta chunks would only produce errors.
      if (!key && decodedCount === 0) return;

      pendingRects.push(parsed.rects);
      try {
        decoder.decode(
          new EncodedVideoChunk({
            type: key ? "key" : "delta",
            timestamp: performance.now() * 1000,
            data: parsed.bitstream,
          }),
        );
      } catch (error) {
        pendingRects.shift();
        post({ type: "error", message: String(error) });
      }
      break;
    }

    case "close": {
      try {
        decoder?.close();
      } catch {
        // already closed
      }
      decoder = null;
      configured = false;
      break;
    }
  }
};
