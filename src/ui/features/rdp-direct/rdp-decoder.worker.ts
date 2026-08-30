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
  | { type: "rect"; payload: ArrayBuffer }
  | { type: "close" };

type OutboundMessage =
  | { type: "ready" }
  | {
      type: "stats";
      decoded: number;
      painted: number;
      elapsedMs: number;
      drops: typeof drops;
      decoderState: string;
    }
  | { type: "error"; message: string };

declare const self: DedicatedWorkerGlobalScope;

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let decoder: VideoDecoder | null = null;
let configured = false;
let decodedCount = 0;
/*
 * Frames that arrived before the decoder finished configuring.
 *
 * Configuration is asynchronous, and the session's only key frame is its first
 * one. Dropping what arrives in that window loses the IDR, and every later
 * frame is a delta the decoder cannot start from -- so an idle desktop, which
 * sends nothing else for minutes, stays black forever. Held and replayed
 * instead.
 */
const pendingChunks: ArrayBuffer[] = [];
const MAX_PENDING_CHUNKS = 64;

/* Why frames do not reach the canvas. Every rejection below is silent by
 * design -- a dropped frame is not an error -- which makes a black screen
 * impossible to explain without counting them. */
const drops = { unconfigured: 0, unparsed: 0, noKey: 0, decodeError: 0 };
/* Video frames only. The key-frame gate must not count painted rects: a
 * decoder that has not seen a key frame still cannot take a delta. */
let videoFrames = 0;

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
    videoFrames++;
  } finally {
    frame.close();
  }
}

/*
 * The bridge reports how fast the server produces frames; this reports how fast
 * they actually reach the canvas. The two differ when the decoder falls behind,
 * which is the failure a frame counter on the server side cannot show.
 *
 * Sampled on a timer rather than posted per frame: at 60fps a message per frame
 * is pure overhead on the thread whose latency this path exists to protect.
 */
let statsAt = 0;
let statsPainted = 0;

function reportStats(now: number) {
  if (statsAt === 0) {
    statsAt = now;
    statsPainted = decodedCount;
    return;
  }
  const elapsed = now - statsAt;
  if (elapsed < 5000) return;

  post({
    type: "stats",
    decoded: decodedCount,
    painted: decodedCount - statsPainted,
    elapsedMs: elapsed,
    drops: { ...drops },
    decoderState: decoder ? decoder.state : "none",
  });
  statsAt = now;
  statsPainted = decodedCount;
}

function decodeAvc(payload: ArrayBuffer) {
  if (!decoder || decoder.state !== "configured") {
    // Still configuring. Hold it rather than drop it: the first frame is the
    // one that makes every later frame decodable.
    if (pendingChunks.length < MAX_PENDING_CHUNKS) pendingChunks.push(payload);
    else drops.unconfigured++;
    return;
  }

  const parsed = parseAvcFrame(new Uint8Array(payload));
  if (!parsed || parsed.bitstream.length === 0) {
    drops.unparsed++;
    return;
  }

  const key = isKeyFrame(parsed.bitstream);
  // Until a key frame arrives the decoder has no reference to build on, so
  // delta chunks would only produce errors.
  if (!key && videoFrames === 0) {
    drops.noKey++;
    return;
  }

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
    drops.decodeError++;
    post({ type: "error", message: String(error) });
  }
}

function flushPending() {
  const held = pendingChunks.splice(0, pendingChunks.length);
  for (const chunk of held) decodeAvc(chunk);
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
      flushPending();
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

    /*
     * A decoded region from the bridge, for hosts that never send H.264.
     * Painted straight onto the canvas: there is no decoder involved, so it
     * bypasses the video path entirely and does not disturb its key-frame
     * state.
     */
    case "rect": {
      if (!ctx) return;
      const bytes = new Uint8Array(message.payload);
      if (bytes.length < 10) return;
      const view = new DataView(message.payload);
      const left = view.getUint16(2, true);
      const top = view.getUint16(4, true);
      const width = view.getUint16(6, true);
      const height = view.getUint16(8, true);
      if (width === 0 || height === 0) return;
      if (bytes.length < 10 + width * height * 4) return;

      const image = ctx.createImageData(width, height);
      // BGRA on the wire, RGBA in an ImageData.
      for (let i = 0; i < width * height; i++) {
        const src = 10 + i * 4;
        const dst = i * 4;
        image.data[dst] = bytes[src + 2];
        image.data[dst + 1] = bytes[src + 1];
        image.data[dst + 2] = bytes[src];
        image.data[dst + 3] = 255;
      }
      ctx.putImageData(image, left, top);
      decodedCount++;
      break;
    }

    case "avc": {
      reportStats(performance.now());
      decodeAvc(message.payload);
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
