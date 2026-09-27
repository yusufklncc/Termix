/**
 * What a network profile has to say before it can be saved.
 *
 * A profile that names no gateway is the same failure this fork just fixed in
 * the proxy path: a host marked "reach this through somewhere else" with no
 * somewhere else, connecting directly instead. Refusing it here means the
 * person sees why, while they are still looking at the form.
 */

const GATEWAY_TYPES = new Set(["socks5", "http"]);
const KINDS = new Set(["declared"]);

export function findVpnProfileError(input: unknown): string | null {
  const data = (input ?? {}) as Record<string, unknown>;

  const name = data.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    return "A network profile needs a name";
  }

  const host = data.gatewayHost;
  if (typeof host !== "string" || host.trim().length === 0) {
    return "A network profile needs a gateway address";
  }

  const port = data.gatewayPort;
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    return "A network profile needs a valid gateway port";
  }

  if (
    data.gatewayType !== undefined &&
    !GATEWAY_TYPES.has(String(data.gatewayType))
  ) {
    return "Unsupported gateway type";
  }

  // Managed tunnels (wireguard, openvpn) are phase 8 A1; accepting the value
  // now would promise something nothing implements yet.
  if (data.kind !== undefined && !KINDS.has(String(data.kind))) {
    return "Unsupported profile kind";
  }

  return null;
}
