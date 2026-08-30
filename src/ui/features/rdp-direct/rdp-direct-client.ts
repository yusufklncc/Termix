import { getBasePath } from "@/lib/base-path.ts";
import {
  attachKeyboardLock,
  type KeyboardLockState,
} from "@/lib/keyboard-lock.ts";
import { isFirefoxBrowser } from "@/features/guacamole/guacamole-clipboard.ts";
import {
  encodeRdpFrame,
  readFrameId,
  readHelo,
  RdpFrameReader,
} from "./rdp-wire.ts";
import {
  PTR_FLAGS_DOWN,
  PTR_FLAGS_MOVE,
  PTR_XFLAGS_DOWN,
  rdpButtonFlag,
  rdpExtendedButtonFlag,
  rdpKeyEvent,
  rdpWheelEvent,
} from "./rdp-scancode.ts";

/**
 * Browser half of the direct RDP path.
 *
 * Frames arrive already framed by the bridge and are handed to the decoder
 * worker without being copied through the main thread's rendering path. Input
 * goes back as the same wire format.
 */

export type RdpDirectState = "connecting" | "connected" | "closed" | "failed";

/** Frames painted in the last sampling window, measured in the worker. */
export interface RdpDirectStats {
  /** Frames painted since the session began. */
  decoded: number;
  /** Frames painted during this window. */
  painted: number;
  elapsedMs: number;
  fps: number;
}

export interface RdpDirectOptions {
  hostId: number;
  /** The canvas is created inside this element; see connectRdpDirect. */
  surface: HTMLElement;
  token?: string | null;
  onState(state: RdpDirectState, detail?: string): void;
  onResize?(width: number, height: number): void;
  /**
   * Painted frame rate, sampled roughly every five seconds. The bridge reports
   * what the server produced; this reports what actually reached the canvas,
   * and the gap between them is the decoder falling behind.
   */
  onStats?(stats: RdpDirectStats): void;
  /**
   * Whether reserved browser shortcuts reach the remote desktop. Only some
   * browsers grant the lock, and a viewer whose Ctrl+W closes the tab deserves
   * to know why.
   */
  onKeyboardLock?(state: KeyboardLockState, detail?: string): void;
  /**
   * A condition worth telling the viewer that the session nonetheless
   * survives. `no-h264` means the host draws without H.264, so the slow
   * fallback is carrying the picture.
   */
  onNotice?(code: string): void;
}

export interface RdpDirectHandle {
  close(): void;
}

export function buildRdpDirectUrl({
  isDev,
  basePath,
  location,
}: {
  isDev: boolean;
  basePath: string;
  location: Pick<Location, "protocol" | "host">;
}) {
  if (isDev) return "ws://localhost:30014";
  const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
  return `${wsProtocol}://${location.host}${basePath}/rdp/direct/`;
}

export function connectRdpDirect({
  hostId,
  surface,
  token,
  onState,
  onResize,
  onStats,
  onKeyboardLock,
  onNotice,
}: RdpDirectOptions): RdpDirectHandle {
  const base = buildRdpDirectUrl({
    isDev: import.meta.env.DEV,
    basePath: getBasePath(),
    location: window.location,
  });

  const url = new URL(base.replace(/\/$/, "") + "/");
  url.searchParams.set("hostId", String(hostId));
  if (token) url.searchParams.set("token", token);

  const rect = surface.getBoundingClientRect();
  url.searchParams.set("width", String(Math.round(rect.width) || 1920));
  url.searchParams.set("height", String(Math.round(rect.height) || 1080));

  const worker = new Worker(
    new URL("./rdp-decoder.worker.ts", import.meta.url),
    { type: "module" },
  );

  // The canvas is created here rather than taken from React. A canvas can only
  // ever be transferred to a worker once, and React reuses the same element
  // across effect runs -- under StrictMode's double invoke that second transfer
  // throws, and an exception escaping the effect unmounts the whole app.
  const canvas = document.createElement("canvas");
  canvas.className =
    "absolute inset-0 w-full h-full object-contain pointer-events-none";
  surface.appendChild(canvas);

  const offscreen = canvas.transferControlToOffscreen();
  worker.postMessage({ type: "init", canvas: offscreen }, [offscreen]);

  worker.onmessage = (event: MessageEvent) => {
    if (event.data?.type === "error") onState("failed", event.data.message);
    else if (event.data?.type === "stats" && onStats) {
      const { decoded, painted, elapsedMs } = event.data;
      onStats({
        decoded,
        painted,
        elapsedMs,
        fps: elapsedMs > 0 ? (painted * 1000) / elapsedMs : 0,
      });
    }
  };

  const socket = new WebSocket(url.toString());
  socket.binaryType = "arraybuffer";

  const reader = new RdpFrameReader();
  let closed = false;
  let remote = { width: 0, height: 0 };

  const send = (magic: string, payload: Uint8Array) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(encodeRdpFrame(magic, payload));
    }
  };

  const u16 = (...values: number[]) => {
    const out = new Uint8Array(values.length * 2);
    const view = new DataView(out.buffer);
    values.forEach((value, index) => view.setUint16(index * 2, value, true));
    return out;
  };

  /* ---- clipboard ---- */

  /*
   * Text both ways.
   *
   * Incoming is simple: the bridge sends what was copied on the remote side and
   * it goes to the local clipboard.
   *
   * Outgoing cannot be: a page may only read the clipboard while focused and
   * with permission, so there is no event that says "the user copied
   * something". The guacd path solves this by reading on focus, and this
   * follows it -- including skipping Firefox, where the read is gated in a way
   * that makes it fail rather than prompt.
   */
  const sendClipboardToRemote = () => {
    if (isFirefoxBrowser() || !navigator.clipboard?.readText) return;
    navigator.clipboard
      .readText()
      .then((text) => {
        if (text) send("CLIP", new TextEncoder().encode(text));
      })
      // Denied permission or an unfocused document. Neither is worth
      // reporting: the session works, this one direction does not.
      .catch(() => {});
  };

  const receiveClipboard = (payload: Uint8Array) => {
    const text = new TextDecoder().decode(payload);
    if (!text || !navigator.clipboard?.writeText) return;
    navigator.clipboard.writeText(text).catch(() => {});
  };

  /* ---- cursor ---- */

  /*
   * The remote cursor arrives as its own update rather than baked into the
   * video, so it has to be drawn here or the desktop loses every shape it uses
   * to say what a spot does -- resize handles, the text I-beam, the spinner.
   *
   * It becomes a CSS cursor on the surface rather than a sprite on the canvas:
   * the browser then moves it at the mouse's rate instead of the stream's, so
   * it stays responsive at any frame rate, and it cannot lag behind the pointer
   * the way a painted one would.
   */
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

  /* ---- input ---- */

  const toRemote = (clientX: number, clientY: number) => {
    if (!remote.width || !remote.height) return null;
    const box = canvas.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return null;

    const scale = Math.min(
      box.width / remote.width,
      box.height / remote.height,
    );
    const offsetX = (box.width - remote.width * scale) / 2;
    const offsetY = (box.height - remote.height * scale) / 2;
    const x = (clientX - box.left - offsetX) / scale;
    const y = (clientY - box.top - offsetY) / scale;
    if (x < 0 || y < 0 || x > remote.width || y > remote.height) return null;
    return { x: Math.round(x), y: Math.round(y) };
  };

  let last = { x: 0, y: 0 };
  const heldKeys = new Set<string>();

  const onPointerMove = (event: PointerEvent) => {
    const point = toRemote(event.clientX, event.clientY);
    if (!point) return;
    last = point;
    send("MOUS", u16(PTR_FLAGS_MOVE, point.x, point.y));
  };

  const onPointerDown = (event: PointerEvent) => {
    surface.focus();
    // Clicking into the session is the moment before a paste, and the moment
    // the document is certainly focused enough to read the clipboard.
    sendClipboardToRemote();
    const point = toRemote(event.clientX, event.clientY) ?? last;
    last = point;

    const flag = rdpButtonFlag(event.button);
    if (flag !== null) {
      send("MOUS", u16(flag | PTR_FLAGS_DOWN, point.x, point.y));
      return;
    }
    const extended = rdpExtendedButtonFlag(event.button);
    if (extended !== null) {
      send("EMOU", u16(extended | PTR_XFLAGS_DOWN, point.x, point.y));
    }
  };

  const onPointerUp = (event: PointerEvent) => {
    const point = toRemote(event.clientX, event.clientY) ?? last;
    last = point;

    const flag = rdpButtonFlag(event.button);
    if (flag !== null) {
      send("MOUS", u16(flag, point.x, point.y));
      return;
    }
    const extended = rdpExtendedButtonFlag(event.button);
    if (extended !== null) {
      send("EMOU", u16(extended, point.x, point.y));
    }
  };

  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const wheel = rdpWheelEvent(event.deltaX, event.deltaY);
    if (!wheel) return;
    send("MOUS", u16(wheel.flags, last.x, last.y));
  };

  const onContextMenu = (event: Event) => event.preventDefault();

  const onKeyDown = (event: KeyboardEvent) => {
    const key = rdpKeyEvent(event.code, true);
    if (!key) return;
    event.preventDefault();
    heldKeys.add(event.code);
    send("KEYE", u16(key.flags, key.code));
  };

  const onKeyUp = (event: KeyboardEvent) => {
    const key = rdpKeyEvent(event.code, false);
    if (!key) return;
    event.preventDefault();
    heldKeys.delete(event.code);
    send("KEYE", u16(key.flags, key.code));
  };

  /** A modifier held while focus leaves would otherwise stay down remotely. */
  const releaseAll = () => {
    for (const code of heldKeys) {
      const key = rdpKeyEvent(code, false);
      if (key) send("KEYE", u16(key.flags, key.code));
    }
    heldKeys.clear();
  };

  // Reserved browser shortcuts -- Ctrl+W above all -- cannot be stopped with
  // preventDefault, so Ctrl+W in a remote session closes the Termix tab. The
  // lock claims them, but only while fullscreen, which the app already has a
  // control for.
  const keyboardLock = attachKeyboardLock({ onState: onKeyboardLock });

  surface.addEventListener("pointermove", onPointerMove);
  surface.addEventListener("pointerdown", onPointerDown);
  surface.addEventListener("pointerup", onPointerUp);
  surface.addEventListener("wheel", onWheel, { passive: false });
  surface.addEventListener("contextmenu", onContextMenu);
  surface.addEventListener("keydown", onKeyDown);
  surface.addEventListener("keyup", onKeyUp);
  surface.addEventListener("blur", releaseAll);
  window.addEventListener("blur", releaseAll);

  /* ---- transport ---- */

  socket.addEventListener("open", () => onState("connecting"));

  socket.addEventListener("message", (event) => {
    const chunk = new Uint8Array(event.data as ArrayBuffer);
    for (const frame of reader.push(chunk)) {
      switch (frame.magic) {
        case "HELO": {
          const size = readHelo(frame.payload);
          if (!size) break;
          remote = size;
          worker.postMessage({ type: "resize", ...size });
          onResize?.(size.width, size.height);
          onState("connected");
          break;
        }

        case "AVCF": {
          // Transferred, not copied: the payload leaves this thread entirely.
          const buffer = frame.payload.buffer.slice(
            frame.payload.byteOffset,
            frame.payload.byteOffset + frame.payload.length,
          );
          worker.postMessage({ type: "avc", payload: buffer }, [buffer]);
          break;
        }

        case "FEND": {
          const frameId = readFrameId(frame.payload);
          if (frameId === null) break;
          // Acknowledging is what keeps the server sending, and holding the ack
          // back when we are behind is the back-pressure.
          const payload = new Uint8Array(4);
          new DataView(payload.buffer).setUint32(0, frameId, true);
          send("FACK", payload);
          break;
        }

        case "CURS": {
          applyCursor(frame.payload);
          break;
        }

        case "CURD": {
          surface.style.cursor = "default";
          break;
        }

        case "CLIP": {
          receiveClipboard(frame.payload);
          break;
        }

        case "RECT": {
          const buffer = frame.payload.buffer.slice(
            frame.payload.byteOffset,
            frame.payload.byteOffset + frame.payload.length,
          );
          worker.postMessage({ type: "rect", payload: buffer }, [buffer]);
          break;
        }

        case "WARN": {
          // A condition the session survives. The code is stable so the UI can
          // explain it in the viewer's language.
          onNotice?.(new TextDecoder().decode(frame.payload));
          break;
        }

        case "ERRR": {
          onState("failed", new TextDecoder().decode(frame.payload));
          break;
        }

        case "BYE ": {
          onState("closed");
          break;
        }

        default:
          break;
      }
    }
  });

  socket.addEventListener("close", (event) => {
    // A bare "closed" tells nobody anything; the close code and reason are the
    // only clue when the session ends without an error frame.
    if (!closed) {
      onState(
        "closed",
        `websocket closed (${event.code}${event.reason ? `: ${event.reason}` : ""})`,
      );
    }
  });

  socket.addEventListener("error", () => {
    if (!closed) onState("failed", "websocket error");
  });

  return {
    close() {
      closed = true;
      releaseAll();
      surface.removeEventListener("pointermove", onPointerMove);
      surface.removeEventListener("pointerdown", onPointerDown);
      surface.removeEventListener("pointerup", onPointerUp);
      surface.removeEventListener("wheel", onWheel);
      surface.removeEventListener("contextmenu", onContextMenu);
      surface.removeEventListener("keydown", onKeyDown);
      surface.removeEventListener("keyup", onKeyUp);
      surface.removeEventListener("blur", releaseAll);
      window.removeEventListener("blur", releaseAll);

      keyboardLock.release();

      // The cursor lives on the surface, which outlives this session.
      surface.style.cursor = "";

      worker.postMessage({ type: "close" });
      worker.terminate();
      canvas.remove();
      try {
        socket.close();
      } catch {
        // already closed
      }
    },
  };
}
