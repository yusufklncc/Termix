import { buttonCodeFromEvent, keysymFromEvent } from "./keysym.ts";

/**
 * Keyboard and pointer forwarding for the WebRTC stream path.
 *
 * neko carries input as control/* events on the same socket the signaling uses,
 * so these go back through Termix's gateway as publisher passthrough. That is a
 * few hundred bytes per second — the media itself still never touches Termix.
 *
 * Selkies carries input on the WebRTC data channel instead, as CSV text. Both
 * wire formats were taken from the servers that parse them, not inferred.
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

/**
 * Selkies mouse button mask (src/selkies/input_handler.py, send_x11_mouse).
 * Scroll occupies bits 3/4 and 6/7 and is pulsed: the server acts on the 0→1
 * edge, so a wheel notch sets the bit and immediately clears it.
 */
const SELKIES_MASK = {
  left: 1 << 0,
  middle: 1 << 1,
  right: 1 << 2,
  scrollUp: 1 << 3,
  scrollDown: 1 << 4,
  scrollLeft: 1 << 6,
  scrollRight: 1 << 7,
} as const;

function selkiesMaskBit(button: number): number | null {
  switch (button) {
    case 0:
      return SELKIES_MASK.left;
    case 1:
      return SELKIES_MASK.middle;
    case 2:
      return SELKIES_MASK.right;
    default:
      return null;
  }
}

/**
 * Turns a wheel delta into the server's notch magnitude. The reference client
 * learns each device's notch size; this uses the common 100px-per-notch value
 * and clamps, which the server clamps again at 64.
 */
export function scrollMagnitude(delta: number, deltaMode: number): number {
  const notches = deltaMode === 0 ? Math.abs(delta) / 100 : Math.abs(delta);
  return Math.max(1, Math.min(Math.round(notches) || 1, 10));
}

/**
 * Wires input for a Selkies host over its data channel. Returns a cleanup
 * function.
 */
export function attachSelkiesInput({
  surface,
  video,
  send,
}: {
  surface: HTMLElement;
  video: HTMLVideoElement;
  send: (text: string) => void;
}): () => void {
  let last: RemotePoint = { x: 0, y: 0 };
  let mask = 0;
  const heldKeysyms = new Set<number>();

  const sendMouse = (magnitude = 0) => {
    send(`m,${last.x},${last.y},${mask},${magnitude}`);
  };

  const track = (event: PointerEvent | WheelEvent) => {
    const point = mapPointerToRemote(video, event.clientX, event.clientY);
    if (point) last = point;
    return point;
  };

  const onPointerMove = (event: PointerEvent) => {
    if (track(event)) sendMouse();
  };

  const onPointerDown = (event: PointerEvent) => {
    const bit = selkiesMaskBit(event.button);
    if (bit === null) return;
    surface.focus();
    track(event);
    mask |= bit;
    sendMouse();
  };

  const onPointerUp = (event: PointerEvent) => {
    const bit = selkiesMaskBit(event.button);
    if (bit === null) return;
    track(event);
    mask &= ~bit;
    sendMouse();
  };

  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    track(event);
    const magnitude = scrollMagnitude(
      event.deltaY || event.deltaX,
      event.deltaMode,
    );

    let bit = 0;
    if (event.deltaY < 0) bit = SELKIES_MASK.scrollUp;
    else if (event.deltaY > 0) bit = SELKIES_MASK.scrollDown;
    else if (event.deltaX < 0) bit = SELKIES_MASK.scrollLeft;
    else if (event.deltaX > 0) bit = SELKIES_MASK.scrollRight;
    if (!bit) return;

    // Pulse: the server scrolls on the rising edge only.
    mask |= bit;
    sendMouse(magnitude);
    mask &= ~bit;
    sendMouse(magnitude);
  };

  const onContextMenu = (event: Event) => event.preventDefault();

  const onKeyDown = (event: KeyboardEvent) => {
    const keysym = keysymFromEvent(event);
    if (keysym === null) return;
    event.preventDefault();
    heldKeysyms.add(keysym);
    send(`kd,${keysym}`);
  };

  const onKeyUp = (event: KeyboardEvent) => {
    const keysym = keysymFromEvent(event);
    if (keysym === null) return;
    event.preventDefault();
    heldKeysyms.delete(keysym);
    send(`ku,${keysym}`);
  };

  const releaseAll = () => {
    heldKeysyms.clear();
    // Selkies has a reset verb, which also clears anything the server still
    // believes is held after a dropped keyup.
    send("kr");
    mask = 0;
    sendMouse();
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
