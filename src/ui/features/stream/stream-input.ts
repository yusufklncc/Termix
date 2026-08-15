import { buttonCodeFromEvent, keysymFromEvent } from "./keysym.ts";

/**
 * Keyboard and pointer forwarding for the WebRTC stream path.
 *
 * neko carries input as control/* events on the same socket the signaling uses,
 * so these go back through Termix's gateway as publisher passthrough. That is a
 * few hundred bytes per second — the media itself still never touches Termix.
 *
 * Selkies is deliberately not handled here: it carries input on the WebRTC data
 * channel in a binary format that is not documented anywhere I could verify, and
 * guessing at a wire format is how you get a desktop that types the wrong keys.
 */

export type PublisherSend = (event: string, payload: unknown) => void;

export interface RemotePoint {
  x: number;
  y: number;
}

/**
 * Maps a viewport coordinate onto the remote screen.
 *
 * The video is rendered with object-contain, so it is letterboxed inside the
 * element and the visible content box is generally smaller than the element.
 * Returns null for points in the letterbox, which have no remote equivalent.
 */
export function mapPointerToRemote(
  video: Pick<
    HTMLVideoElement,
    "videoWidth" | "videoHeight" | "getBoundingClientRect"
  >,
  clientX: number,
  clientY: number,
): RemotePoint | null {
  const { videoWidth, videoHeight } = video;
  if (!videoWidth || !videoHeight) return null;

  const rect = video.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  const scale = Math.min(rect.width / videoWidth, rect.height / videoHeight);
  const contentWidth = videoWidth * scale;
  const contentHeight = videoHeight * scale;
  const offsetX = (rect.width - contentWidth) / 2;
  const offsetY = (rect.height - contentHeight) / 2;

  const x = (clientX - rect.left - offsetX) / scale;
  const y = (clientY - rect.top - offsetY) / scale;

  if (x < 0 || y < 0 || x > videoWidth || y > videoHeight) return null;

  return { x: Math.round(x), y: Math.round(y) };
}

const NEKO = {
  request: "control/request",
  release: "control/release",
  move: "control/move",
  scroll: "control/scroll",
  buttonDown: "control/buttondown",
  buttonUp: "control/buttonup",
  keyDown: "control/keydown",
  keyUp: "control/keyup",
} as const;

/**
 * Wires input for a neko host. Returns a cleanup function.
 *
 * `surface` takes the DOM events (it can be focused, the video element cannot),
 * `video` supplies the remote resolution used to scale coordinates.
 */
export function attachNekoInput({
  surface,
  video,
  send,
}: {
  surface: HTMLElement;
  video: HTMLVideoElement;
  send: PublisherSend;
}): () => void {
  let last: RemotePoint = { x: 0, y: 0 };
  /** Keys currently down, so focus loss can release them instead of sticking. */
  const heldKeysyms = new Set<number>();

  // neko hands control to one viewer at a time; without this the desktop
  // ignores everything sent below.
  send(NEKO.request, {});

  const track = (event: PointerEvent | MouseEvent | WheelEvent) => {
    const point = mapPointerToRemote(video, event.clientX, event.clientY);
    if (point) last = point;
    return point;
  };

  const onPointerMove = (event: PointerEvent) => {
    const point = track(event);
    if (point) send(NEKO.move, point);
  };

  const onPointerDown = (event: PointerEvent) => {
    const code = buttonCodeFromEvent(event.button);
    if (code === null) return;
    surface.focus();
    const point = track(event) ?? last;
    send(NEKO.buttonDown, { ...point, code });
  };

  const onPointerUp = (event: PointerEvent) => {
    const code = buttonCodeFromEvent(event.button);
    if (code === null) return;
    const point = track(event) ?? last;
    send(NEKO.buttonUp, { ...point, code });
  };

  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const point = track(event) ?? last;
    send(NEKO.scroll, {
      ...point,
      delta_x: Math.round(event.deltaX),
      delta_y: Math.round(event.deltaY),
      control_key: event.ctrlKey,
    });
  };

  const onContextMenu = (event: Event) => event.preventDefault();

  const onKeyDown = (event: KeyboardEvent) => {
    const keysym = keysymFromEvent(event);
    if (keysym === null) return;
    // Browser shortcuts would otherwise fire locally instead of remotely.
    event.preventDefault();
    heldKeysyms.add(keysym);
    send(NEKO.keyDown, { ...last, keysym });
  };

  const onKeyUp = (event: KeyboardEvent) => {
    const keysym = keysymFromEvent(event);
    if (keysym === null) return;
    event.preventDefault();
    heldKeysyms.delete(keysym);
    send(NEKO.keyUp, { ...last, keysym });
  };

  /** Leaving the tab with a modifier down must not leave it stuck remotely. */
  const releaseAll = () => {
    for (const keysym of heldKeysyms) {
      send(NEKO.keyUp, { ...last, keysym });
    }
    heldKeysyms.clear();
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

  return () => {
    releaseAll();
    send(NEKO.release, {});
    surface.removeEventListener("pointermove", onPointerMove);
    surface.removeEventListener("pointerdown", onPointerDown);
    surface.removeEventListener("pointerup", onPointerUp);
    surface.removeEventListener("wheel", onWheel);
    surface.removeEventListener("contextmenu", onContextMenu);
    surface.removeEventListener("keydown", onKeyDown);
    surface.removeEventListener("keyup", onKeyUp);
    surface.removeEventListener("blur", releaseAll);
    window.removeEventListener("blur", releaseAll);
  };
}
