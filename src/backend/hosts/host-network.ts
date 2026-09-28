import type { ProxyNode } from "../../types/index.js";
import type { SOCKS5Config } from "../utils/proxy-helper.js";
import { createCurrentVpnProfileRepository } from "../database/repositories/factory.js";
import type { VpnProfileRecord } from "../database/repositories/vpn-profile-repository.js";
import { sshLogger } from "../utils/logger.js";
import { getErrorMessage } from "../utils/error-message.js";
import {
  managedDoorPort,
  resolveNetManagerOptions,
} from "../utils/net-manager-client.js";

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
  /**
   * Whose host this is. A network profile belongs to a user, so resolving one
   * needs to know whose it should be; without it there is no way to tell, and
   * guessing is how a host ends up on someone else's network.
   *
   * Required, and explicitly nullable, so that every caller has to say -- a
   * field that may be left out is a field that gets left out.
   */
  userId: string | null | undefined;
}

type ProfileLoader = (
  id: number,
  userId: string,
) => Promise<VpnProfileRecord | null>;

const loadProfileFromDatabase: ProfileLoader = (id, userId) =>
  createCurrentVpnProfileRepository().findById(id, userId);

/** A gateway speaking HTTP CONNECT is expressed as a one-node chain, which is
 * the path proxy-helper already has for mixed chains. */
function profileToConfig(profile: VpnProfileRecord): SOCKS5Config {
  /*
   * A managed network's address is worked out, not remembered.
   *
   * Termix raised this tunnel, so it knows where the doorway is: the manager,
   * on a port derived from the profile's id. Trusting the stored copy would
   * mean a row edited by hand, or written before the manager moved, could
   * send a customer's traffic to another customer's doorway.
   */
  if (profile.kind === "managed") {
    /*
     * Switched off on purpose.
     *
     * The doorway is gone, so this would fail anyway -- but as "nothing is
     * listening", which reads like a fault. Someone turned it off, and that
     * is a different thing to be told.
     */
    if (profile.enabled === false) {
      throw new Error("This host's network is switched off");
    }

    const manager = resolveNetManagerOptions();
    if (!manager) {
      throw new Error(
        "This host's network is managed by Termix, but no network manager is configured",
      );
    }
    return {
      useSocks5: true,
      socks5Host: manager.host,
      socks5Port: managedDoorPort(profile.id),
    };
  }

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
    /*
     * Whose profile this should be has to be known, not assumed.
     *
     * Ids are small integers, and a profile reaches a gateway with stored
     * credentials. Resolving one without an owner would let a host carry
     * someone else's id and leave through their network. There is no safe
     * default here, so this refuses rather than picking one.
     */
    if (!host.userId) {
      throw new Error(
        "This host is assigned to a network profile, but its owner is unknown",
      );
    }

    const profile = await loadProfile(host.vpnProfileId, host.userId);

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

/**
 * How a host is reached, copied as a unit.
 *
 * Several places rebuild a host into some other shape -- a tunnel's config, a
 * session's config -- by listing its fields one by one, and every such list
 * written by hand has so far forgotten at least one of these. Tunnels carried
 * none of them, so a host set to go through a proxy or a network had its
 * tunnel leave by the server's own route instead.
 *
 * Spreading this keeps the set together: adding a field here reaches every
 * caller at once.
 */
export interface HostNetworkFields {
  id?: number | string;
  userId: string | null;
  vpnProfileId: number | null;
  useSocks5: boolean;
  socks5Host?: string;
  socks5Port?: number;
  socks5Username?: string;
  socks5Password?: string;
  socks5ProxyChain?: ProxyNode[];
}

/**
 * Loosely typed on purpose: this is fed host rows, session configs and
 * request bodies, whose own shapes declare these fields as optional.
 */
export interface HostNetworkSource {
  id?: number | string;
  userId?: string | null;
  vpnProfileId?: number | null;
  useSocks5?: boolean | null;
  socks5Host?: string | null;
  socks5Port?: number | null;
  socks5Username?: string | null;
  socks5Password?: string | null;
  socks5ProxyChain?: unknown;
}

export function hostNetworkFields(host: HostNetworkSource): HostNetworkFields {
  return {
    id: host.id,
    userId: host.userId ?? null,
    vpnProfileId: host.vpnProfileId ?? null,
    useSocks5: !!host.useSocks5,
    socks5Host: host.socks5Host ?? undefined,
    socks5Port: host.socks5Port ?? undefined,
    socks5Username: host.socks5Username ?? undefined,
    socks5Password: host.socks5Password ?? undefined,
    socks5ProxyChain: Array.isArray(host.socks5ProxyChain)
      ? (host.socks5ProxyChain as ProxyNode[])
      : undefined,
  };
}

/**
 * What to call the thing that failed.
 *
 * "Proxy" is not in the vocabulary of someone who set a host's **Network** in
 * the editor; naming the wrong thing sends them looking in the wrong place.
 * The host itself says which of the two it was reached through.
 */
export function gatewayFailureMessage(
  host: Pick<HostNetworkInput, "vpnProfileId">,
  error: unknown,
): string {
  const what = host.vpnProfileId
    ? "Network connection failed"
    : "Proxy connection failed";
  return `${what}: ${getErrorMessage(error)}`;
}
