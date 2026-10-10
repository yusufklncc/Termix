import type { SOCKS5Config } from "../../utils/socks5-helper.js";
import type { ProxyNode } from "../../../types/index.js";
import { getServiceImplementation } from "../../plugins/service-registry.js";
import type { SshConnectHost } from "./types.js";

/**
 * "What should this host leave through?", asked of whoever can answer.
 *
 * A host may be reached through something core does not itself know how to
 * raise -- a VPN, a mesh -- and the plugin that raises it is the only thing
 * that can say where its doorway is. Core asks here rather than listing the
 * kinds, so a way of reaching a host that ships later needs no change to the
 * connect path.
 *
 * Null means "nothing of mine applies", not "connect directly": the host's
 * own proxy is still core's to read, below.
 */
export const HOST_GATEWAY_SERVICE = "host.gateway";
export const HOST_GATEWAY_VERSION = "^1";

export interface HostGatewayService {
  forHost(host: {
    id?: number | string;
    userId?: string | null;
    [key: string]: unknown;
  }): Promise<SOCKS5Config | null>;
  /**
   * How to word a failure to reach the host through what forHost returned.
   *
   * Core no longer knows what kind of thing that is, and "Proxy connection
   * failed" sends someone who set a host's **VPN** looking in the wrong
   * place. Whoever answered names it.
   */
  describeFailure?(error: unknown): string;
}

/**
 * The host's own proxy fields, as the editor wrote them.
 *
 * Core's, not a plugin's: useSocks5 and its address are columns on the host
 * and mean the same thing whatever else is installed.
 */
function hostOwnProxy(host: SshConnectHost): SOCKS5Config | null {
  const chain = Array.isArray(host.socks5ProxyChain)
    ? (host.socks5ProxyChain as ProxyNode[])
    : [];
  if (!host.useSocks5 || (!host.socks5Host && chain.length === 0)) return null;
  return {
    useSocks5: host.useSocks5,
    socks5Host: host.socks5Host ?? undefined,
    socks5Port: host.socks5Port ?? undefined,
    socks5Username: host.socks5Username ?? undefined,
    socks5Password: host.socks5Password ?? undefined,
    socks5ProxyChain: chain,
  };
}

/**
 * Where this host's traffic leaves, or null when it leaves directly.
 *
 * A provider's refusal is thrown, not swallowed: "this VPN is switched off"
 * and "that profile is gone" are the reasons the field exists, and carrying
 * on would connect by exactly the route the host was configured to avoid.
 */
export interface ResolvedGateway {
  config: SOCKS5Config;
  /** Words a failure to connect through it, for whoever reads the error. */
  describeFailure(error: unknown): string;
}

function proxyFailure(error: unknown): string {
  return `Proxy connection failed: ${
    error instanceof Error ? error.message : String(error)
  }`;
}

export async function resolveHostGateway(
  host: SshConnectHost,
): Promise<ResolvedGateway | null> {
  const provider = getServiceImplementation<HostGatewayService>(
    HOST_GATEWAY_SERVICE,
    HOST_GATEWAY_VERSION,
  );

  const fromProvider = provider ? await provider.forHost(host as never) : null;
  if (fromProvider) {
    return {
      config: fromProvider,
      describeFailure: (error) =>
        provider?.describeFailure?.(error) ?? proxyFailure(error),
    };
  }

  const own = hostOwnProxy(host);
  return own ? { config: own, describeFailure: proxyFailure } : null;
}
