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
import {
  codecFromSps,
  isForeignFrameSize,
  mapRectToFrame,
} from "./rdp-decode-policy.ts";

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
  | { type: "error"; message: string }
  /* The browser cannot decode this stream. The bridge can decode it instead
   * and send pixels -- slower, but a picture. */
  | { type: "decoder-unusable" };

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

/* How long a first picture may sit undelivered before the decoder is pushed.
 * Long enough that a session sending frames resolves on its own. */
const STUCK_FRAME_MS = 150;

/* How long software decoding gets to produce a picture before the session
 * falls back to letting the bridge decode. */
const SOFTWARE_GRACE_MS = 2500;

/* Why frames do not reach the canvas. Every rejection below is silent by
 * design -- a dropped frame is not an error -- which makes a black screen
 * impossible to explain without counting them. */
const drops = { unconfigured: 0, unparsed: 0, noKey: 0, decodeError: 0 };
/* Video frames only. The key-frame gate must not count painted rects: a
 * decoder that has not seen a key frame still cannot take a delta. */
let videoFrames = 0;
/*
 * A decoder accepts nothing but a key frame after configure() and after
 * flush(). Feeding it a delta there throws DataError and loses the stream, so
 * the state is tracked rather than inferred from the frame count.
 */
let needsKeyFrame = true;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/*
 * Which decoder implementation is in use.
 *
 * A hardware decoder can accept a stream, emit frames, and produce nothing but
 * a blank picture at a size it invented -- measured against a Windows host
 * encoding 1152x1136, which ffmpeg decodes correctly while the browser
 * reported 1280x720 and painted green. Unusual resolutions are where that
 * happens, and RDP produces them constantly because it aligns the desktop to
 * macroblocks rather than to a video standard.
 *
 * So hardware is tried first, and software is the fallback when no picture
 * arrives -- not the default, since decoding in software is the cost this path
 * exists to avoid.
 */
let softwareFallbackUsed = false;
let flushedOnce = false;
let lastCodec: string | null = null;
/*
 * The most recent key frame, kept so a decoder can be restarted.
 *
 * configure() and flush() both leave a decoder that will accept nothing but a
 * key frame, and RDP does not send one on request -- an idle desktop may go
 * minutes without another. Replaying the one already seen is what makes
 * reconfiguring viable at all.
 */
let lastKeyChunk: ArrayBuffer | null = null;

/** Rects for the frame currently in flight, in submission order. */
const pendingRects: RdpRect[][] = [];

function post(message: OutboundMessage) {
  self.postMessage(message);
}

let gaveUp = false;
let softwareWatchdog: ReturnType<typeof setTimeout> | null = null;

function giveUpOnDecoding(reason: string) {
  if (gaveUp) return;
  gaveUp = true;
  if (softwareWatchdog !== null) {
    clearTimeout(softwareWatchdog);
    softwareWatchdog = null;
  }
  console.warn(`[rdp-direct] browser cannot decode this stream: ${reason}`);
  post({ type: "decoder-unusable" });
}

function paint(frame: VideoFrame) {
  const rects = pendingRects.shift();

  if (
    softwareFallbackUsed &&
    isForeignFrameSize(
      { width: frame.displayWidth, height: frame.displayHeight },
      { width: canvas ? canvas.width : 0, height: canvas ? canvas.height : 0 },
    )
  ) {
    // Software failed the same way hardware did, so it is not the decoder
    // implementation -- this browser cannot decode this stream at all.
    frame.close();
    giveUpOnDecoding("software decoder also returned a foreign size");
    return;
  }

  if (
    !softwareFallbackUsed &&
    lastCodec &&
    isForeignFrameSize(
      { width: frame.displayWidth, height: frame.displayHeight },
      { width: canvas ? canvas.width : 0, height: canvas ? canvas.height : 0 },
    )
  ) {
    console.warn(
      `[rdp-direct] hardware decoder returned ${frame.displayWidth}x${frame.displayHeight} ` +
        `for a ${canvas?.width}x${canvas?.height} surface; switching to software`,
    );
    softwareFallbackUsed = true;
    configured = false;
    const codec = lastCodec;
    const before = videoFrames;
    frame.close();
    queueMicrotask(() => applyConfig(codec));
    softwareWatchdog = setTimeout(() => {
      softwareWatchdog = null;
      // The key frame was replayed into the reconfigured decoder, so this is a
      // fair verdict rather than a decoder that was never given anything.
      if (videoFrames === before)
        giveUpOnDecoding(
          "software decoder produced nothing from a replayed key frame",
        );
    }, SOFTWARE_GRACE_MS);
    return;
  }

  if (!ctx) {
    frame.close();
    return;
  }

  try {
    /*
     * The coded picture is not always the size of the surface. A server may
     * encode the desktop at a fixed resolution and still describe the update as
     * covering the whole surface -- measured against a Windows host encoding
     * 1280x720 for surfaces of 1126x1130 and 1684x1282 alike. Drawing that one
     * to one puts a fraction of the picture in the corner.
     *
     * So the rects, which are in surface coordinates, are mapped into the
     * picture through the ratio between the two. Where the sizes agree the
     * ratio is one and this is the same 1:1 copy as before.
     */
    const surface = {
      width: canvas ? canvas.width : frame.displayWidth,
      height: canvas ? canvas.height : frame.displayHeight,
    };
    const picture = {
      width: frame.displayWidth,
      height: frame.displayHeight,
    };

    if (!rects || rects.length === 0) {
      ctx.drawImage(
        frame,
        0,
        0,
        frame.displayWidth,
        frame.displayHeight,
        0,
        0,
        surface.width,
        surface.height,
      );
    } else {
      // The picture covers the whole surface; the rects say which parts of it
      // actually changed. Painting only those avoids redrawing stale areas.
      for (const rect of rects) {
        const source = mapRectToFrame(rect, picture, surface);
        if (!source) continue;
        ctx.drawImage(
          frame,
          source.sx,
          source.sy,
          source.sw,
          source.sh,
          rect.left,
          rect.top,
          rect.right - rect.left,
          rect.bottom - rect.top,
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

/* The 5s stats window says nothing on an idle desktop, where a handful of
 * frames decide whether anything is ever drawn. This reports the first one
 * immediately, with the state that decided its fate. */

function decodeAvc(payload: ArrayBuffer) {
  const parsed = parseAvcFrame(new Uint8Array(payload));
  if (!parsed || parsed.bitstream.length === 0) {
    drops.unparsed++;
    return;
  }

  // The configuration comes out of the stream, so it cannot happen until a
  // frame carrying an SPS arrives. Anything before that is held, not dropped:
  // the first frame is the one that makes every later frame decodable.
  if (!configured && !configureFromStream(parsed.bitstream)) {
    if (pendingChunks.length < MAX_PENDING_CHUNKS) pendingChunks.push(payload);
    else drops.unconfigured++;
    return;
  }

  if (!decoder || decoder.state !== "configured") {
    if (pendingChunks.length < MAX_PENDING_CHUNKS) pendingChunks.push(payload);
    else drops.unconfigured++;
    return;
  }

  const key = isKeyFrame(parsed.bitstream);
  // Until a key frame arrives the decoder has no reference to build on, so
  // delta chunks would only produce errors.
  if (needsKeyFrame && !key) {
    drops.noKey++;
    return;
  }

  if (key) {
    // The decoder can take deltas from here, and this frame is what restarts it
    // if it ever has to be reconfigured.
    needsKeyFrame = false;
    lastKeyChunk = payload.slice(0);
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
    /*
     * A Main-profile stream permits frame reordering, so the decoder may hold a
     * picture until the next one establishes display order. A remote desktop
     * nobody is touching never sends that next frame, and the first picture
     * would sit inside the decoder forever.
     *
     * Flushing forces it out, but it also resets the decoder: everything after
     * a flush is refused until another key frame arrives. So it waits to see
     * whether the stream resolves itself, and only steps in when the picture is
     * genuinely stuck -- which on a busy session never happens.
     */
    if (videoFrames === 0 && flushTimer === null) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        if (videoFrames > 0 || !decoder || decoder.state !== "configured")
          return;

        if (!flushedOnce) {
          flushedOnce = true;
          needsKeyFrame = true;
          decoder.flush().catch(() => {
            // A flush racing a reset is not a failure worth reporting.
          });
          return;
        }

        // Flushing did not produce a picture either, so the decoder itself is
        // the problem rather than the ordering.
        if (!softwareFallbackUsed && lastCodec) {
          softwareFallbackUsed = true;
          configured = false;
          applyConfig(lastCodec);
        }
      }, STUCK_FRAME_MS);
    }
  } catch (error) {
    pendingRects.shift();
    drops.decodeError++;
    // Recoverable: the next key frame restarts the stream. Reporting it as a
    // session failure would close a session that is about to right itself.
    needsKeyFrame = true;
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
    error: (error) => {
      post({ type: "error", message: String(error) });
    },
  });
}

function configureFromStream(bitstream: Uint8Array): boolean {
  if (!decoder || configured) return configured;

  const codec = codecFromSps(bitstream);
  if (!codec) return false;

  lastCodec = codec;
  return applyConfig(codec);
}

function applyConfig(codec: string): boolean {
  if (!decoder) return false;
  try {
    // No description: that tells WebCodecs the stream is Annex B, which is what
    // the RDP graphics pipeline carries. optimizeForLatency keeps the decoder
    // from buffering frames it could already have shown.
    decoder.configure({
      codec,
      optimizeForLatency: true,
      ...(softwareFallbackUsed
        ? { hardwareAcceleration: "prefer-software" as const }
        : {}),
    });
    configured = true;
    needsKeyFrame = true;
    console.info(
      `[rdp-direct] decoder configured: ${codec}` +
        (softwareFallbackUsed ? " (software)" : ""),
    );
    queueMicrotask(() => {
      if (lastKeyChunk) decodeAvc(lastKeyChunk.slice(0));
      flushPending();
    });
    return true;
  } catch (error) {
    post({
      type: "error",
      message: `H.264 decoding is not available (${codec}): ${String(error)}`,
    });
    return false;
  }
}

self.onmessage = async (event: MessageEvent<InboundMessage>) => {
  const message = event.data;

  switch (message.type) {
    case "init": {
      canvas = message.canvas;
      ctx = canvas.getContext("2d");
      ensureDecoder();
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
