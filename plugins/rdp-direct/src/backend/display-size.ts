/**
 * Session resolution for the direct RDP path.
 *
 * The size normally comes from the browser's tab, which means a session
 * inherits whatever the window happened to be -- fine for use, useless for
 * comparing one run against another.
 *
 * A host can pin one instead, and it reads the same Display Settings the guacd
 * path already uses rather than asking the same question twice. This module
 * only reads them; nothing about the guacd path changes.
 */

export interface DisplaySizeSources {
  /** The host's stored display settings, JSON text or an object. */
  hostConfig: unknown;
  /** What the browser asked for, from the query string. */
  requestedWidth: string | null;
  requestedHeight: string | null;
}

export interface DisplaySize {
  width: number;
  height: number;
  /** True when the host pinned the size, so the browser's request was ignored. */
  pinned: boolean;
}

const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;

/** Below this an RDP session is not usable; above it, servers refuse. */
const MIN_EDGE = 200;
const MAX_EDGE = 8192;

/**
 * A malformed blob is treated as empty rather than failing the session: the
 * size is a preference, not a credential.
 */
export function parseDisplayConfig(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object") return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * "auto" is how the form says "no pinned size", and it arrives as a string --
 * as does every number the form stores.
 */
export function pinnedDimension(value: unknown): number | null {
  if (value === null || value === undefined || value === "" || value === "auto")
    return null;
  const parsed =
    typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < MIN_EDGE || parsed > MAX_EDGE)
    return null;
  return parsed;
}

export function requestedDimension(value: string | null): number | null {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Width and height are decided together: a host that pins only one of them
 * would otherwise get a mismatched pair, half pinned and half from the window.
 */
export function resolveDisplaySize({
  hostConfig,
  requestedWidth,
  requestedHeight,
}: DisplaySizeSources): DisplaySize {
  const config = parseDisplayConfig(hostConfig);
  const pinnedWidth = pinnedDimension(config.width);
  const pinnedHeight = pinnedDimension(config.height);

  if (pinnedWidth !== null && pinnedHeight !== null) {
    return { width: pinnedWidth, height: pinnedHeight, pinned: true };
  }

  return {
    width: requestedDimension(requestedWidth) ?? DEFAULT_WIDTH,
    height: requestedDimension(requestedHeight) ?? DEFAULT_HEIGHT,
    pinned: false,
  };
}
