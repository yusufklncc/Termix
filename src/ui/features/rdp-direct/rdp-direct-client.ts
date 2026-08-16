import { getBasePath } from "@/lib/base-path.ts";
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

export interface RdpDirectOptions {
  hostId: number;
  canvas: HTMLCanvasElement;
  surface: HTMLElement;
  token?: string | null;
  onState(state: RdpDirectState, detail?: string): void;
  onResize?(width: number, height: number): void;
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
  canvas,
  surface,
  token,
  onState,
  onResize,
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

  const offscreen = canvas.transferControlToOffscreen();
  worker.postMessage({ type: "init", canvas: offscreen }, [offscreen]);

  worker.onmessage = (event: MessageEvent) => {
    if (event.data?.type === "error") onState("failed", event.data.message);
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

  socket.addEventListener("close", () => {
    if (!closed) onState("closed");
  });

  socket.addEventListener("error", () => {
    if (!closed) onState("failed");
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

      worker.postMessage({ type: "close" });
      worker.terminate();
      try {
        socket.close();
      } catch {
        // already closed
      }
    },
  };
}
