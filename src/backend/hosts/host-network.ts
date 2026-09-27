import type { ProxyNode } from "../../types/index.js";
import type { SOCKS5Config } from "../utils/proxy-helper.js";
import { createCurrentVpnProfileRepository } from "../database/repositories/factory.js";
import type { VpnProfileRecord } from "../database/repositories/vpn-profile-repository.js";
import { sshLogger } from "../utils/logger.js";

/**
 * Which network a host is reached through, decided in one place.
 *
 * Every SSH path used to build this itself, identically, seven times over --
 * and each copy turned "a proxy was asked for but cannot be used" into null,
 * which its caller reads as "no proxy needed" and connects directly. For a
 * host that exists to reach a network the server is not on, that is the
 * traffic leaving by the one route it was configured to avoid.
 *
 * So there is exactly one rule here: null means the host genuinely wants a
 * direct connection. Anything else that cannot be honoured throws.
 */

export interface HostNetworkInput {
  id?: number | string;
  vpnProfileId?: number | null;
  useSocks5?: boolean | null;
  socks5Host?: string | null;
  socks5Port?: number | null;
  socks5Username?: string | null;
  socks5Password?: string | null;
  // Loosely typed on purpose: callers hand this straight out of rows and
  // request bodies where it is anything from undefined to a parsed array.
  // It is narrowed with Array.isArray below, which is the only check that
  // actually holds at runtime.
  socks5ProxyChain?: unknown;
}

type ProfileLoader = (id: number) => Promise<VpnProfileRecord | null>;

const loadProfileFromDatabase: ProfileLoader = (id) =>
  createCurrentVpnProfileRepository().findById(id);

/** A gateway speaking HTTP CONNECT is expressed as a one-node chain, which is
 * the path proxy-helper already has for mixed chains. */
function profileToConfig(profile: VpnProfileRecord): SOCKS5Config {
  if (profile.gatewayType === "http") {
    return {
      useSocks5: true,
      socks5ProxyChain: [
        {
          host: profile.gatewayHost,
          port: profile.gatewayPort,
          type: "http",
          username: profile.gatewayUsername ?? undefined,
          password: profile.gatewayPassword ?? undefined,
        },
      ],
    };
  }

  return {
    useSocks5: true,
    socks5Host: profile.gatewayHost,
    socks5Port: profile.gatewayPort,
    socks5Username: profile.gatewayUsername ?? undefined,
    socks5Password: profile.gatewayPassword ?? undefined,
  };
}

export async function resolveHostGateway(
  host: HostNetworkInput,
  loadProfile: ProfileLoader = loadProfileFromDatabase,
): Promise<SOCKS5Config | null> {
  if (host.vpnProfileId) {
    const profile = await loadProfile(host.vpnProfileId);

    /*
     * Assigned to a network that no longer exists.
     *
     * Deleting a profile in use is refused by the API, so reaching this means
     * the row was detached some other way. Connecting anyway would put the
     * traffic on the server's own route, which is precisely what the profile
     * existed to prevent.
     */
    if (!profile) {
      throw new Error(
        "This host is assigned to a network profile that no longer exists",
      );
    }

    if (host.useSocks5) {
      // Both configured. The profile wins because it is the newer, explicit
      // choice, and saying so beats picking one in silence.
      sshLogger.warn("Host has both a network profile and its own proxy", {
        operation: "host_network_conflict",
        hostId: typeof host.id === "number" ? host.id : undefined,
        vpnProfileId: host.vpnProfileId,
      });
    }

    return profileToConfig(profile);
  }

  if (!host.useSocks5) return null;

  const chain = host.socks5ProxyChain;
  if (Array.isArray(chain) && chain.length > 0) {
    return {
      useSocks5: true,
      socks5ProxyChain: chain as ProxyNode[],
    };
  }

  if (
    typeof host.socks5Host === "string" &&
    host.socks5Host.trim().length > 0
  ) {
    return {
      useSocks5: true,
      socks5Host: host.socks5Host,
      socks5Port: host.socks5Port ?? undefined,
      socks5Username: host.socks5Username ?? undefined,
      socks5Password: host.socks5Password ?? undefined,
    };
  }

  throw new Error(
    "This host is configured to connect through a proxy, but no proxy address is set",
  );
}
