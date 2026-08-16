import type { Host, TabType } from "@/types/ui-types";

type ConnectionTabType = "terminal" | "rdp" | "vnc" | "telnet" | "stream";

function isConnectionTabType(type: TabType): type is ConnectionTabType {
  return (
    type === "terminal" ||
    type === "rdp" ||
    type === "vnc" ||
    type === "telnet" ||
    type === "stream"
  );
}

function isConnectionEnabled(host: Host, type: ConnectionTabType): boolean {
  switch (type) {
    case "terminal":
      return host.enableSsh;
    case "rdp":
      return host.enableRdp;
    case "vnc":
      return host.enableVnc;
    case "telnet":
      return host.enableTelnet;
    case "stream":
      return host.enableStream;
  }
}

export function getDefaultConnectionTab(host: Host): ConnectionTabType {
  if (host.enableSsh) return "terminal";
  if (host.enableRdp) return "rdp";
  if (host.enableVnc) return "vnc";
  if (host.enableTelnet) return "telnet";
  if (host.enableStream) return "stream";
  return "terminal";
}

export function resolveHostTabType(
  host: Host,
  preferredType?: TabType,
): TabType {
  if (!preferredType) return getDefaultConnectionTab(host);
  if (!isConnectionTabType(preferredType)) return preferredType;
  if (isConnectionEnabled(host, preferredType)) return preferredType;
  return getDefaultConnectionTab(host);
}

/** Tab types that can be shared at all. `stream` is not one of them. */
const SHAREABLE_TAB_TYPES: TabType[] = ["terminal", "rdp", "vnc", "telnet"];

/**
 * Whether a live session can be handed to someone else.
 *
 * Sharing a remote desktop is guacd's `join`, so it exists only where guacd is
 * in the picture. An RDP host on the direct renderer has no guacd connection to
 * join, and offering the button anyway would produce a link that resolves to
 * "session is no longer active" -- a failure that looks like a bug rather than
 * a missing feature.
 */
export function isTabShareable(
  type: TabType,
  host?: Pick<Host, "rdpRenderEngine">,
): boolean {
  if (!SHAREABLE_TAB_TYPES.includes(type)) return false;
  if (type === "rdp" && host?.rdpRenderEngine === "direct") return false;
  return true;
}
