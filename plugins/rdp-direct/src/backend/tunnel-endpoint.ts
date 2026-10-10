const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Where a tunnel for the bridge should listen, and what to tell the bridge.
 *
 * The bridge dials a host and a port, so anything it must not reach directly
 * -- a jump host chain, a VPN -- is put behind a local listener and the bridge
 * is handed that instead. Which address the listener may use depends on where
 * the bridge runs: in this process's network namespace, loopback is both
 * enough and safest; in another container it has to be a shared interface,
 * and the bridge needs a name that resolves to this one.
 */
export function resolveTunnelEndpoint(
  bridgeHost: string,
  tunnelHost = process.env.RDP_BRIDGE_TUNNEL_HOST,
): { bindHost: string; advertisedHost: string } {
  if (LOOPBACK_HOSTS.has(bridgeHost.toLowerCase())) {
    return { bindHost: "127.0.0.1", advertisedHost: "127.0.0.1" };
  }

  return {
    bindHost: "0.0.0.0",
    advertisedHost: tunnelHost?.trim() || "termix",
  };
}
