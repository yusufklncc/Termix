import net from "node:net";
import type { PluginContext } from "@termix/plugin-sdk/backend";
import {
  managedDoorPort,
  resolveInManagedNetwork,
  resolveNetManagerOptions,
} from "./net-manager-client.js";
import type { VpnProfileRecord, VpnProfileRepository } from "./repository.js";

export interface Socks5Config {
  useSocks5: boolean;
  socks5Host?: string;
  socks5Port?: number;
  socks5Username?: string;
  socks5Password?: string;
  managedNetworkId?: number;
}

/**
 * Where a profile's traffic leaves.
 *
 * A managed network's address is worked out, not remembered. Termix raised
 * that tunnel, so it knows where the doorway is: the manager, on a port
 * derived from the profile's id. Trusting a stored copy would mean a row
 * edited by hand, or written before the manager moved, sending one customer's
 * traffic to another customer's doorway.
 */
export function profileToConfig(profile: VpnProfileRecord): Socks5Config {
  if (profile.kind === "managed") {
    /*
     * Disabled on purpose.
     *
     * Not the same as a tunnel that is simply down: that one is raised when a
     * session needs it. This one is not to be used at all, and the doorway is
     * gone with it -- so without saying so the refusal would read as "nothing
     * is listening", which is a fault rather than a decision.
     */
    if (profile.enabled === false) {
      throw new Error("This host's VPN is disabled");
    }

    const manager = resolveNetManagerOptions();
    if (!manager) {
      throw new Error(
        "This host's VPN is managed by Termix, but no VPN manager is configured",
      );
    }

    return {
      useSocks5: true,
      socks5Host: manager.host,
      socks5Port: managedDoorPort(profile.id),
      // So a name that only exists inside this network can be asked about.
      managedNetworkId: profile.id,
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

/**
 * The service core asks: "what should this host leave through?"
 *
 * Null means this plugin has nothing to say, and core then reads the host's
 * own proxy fields. A refusal is thrown instead, because "switched off" and
 * "that profile is gone" are the reasons the field exists -- answering null
 * would send the session out by the route the host was configured to avoid.
 */
export function createGatewayService(
  ctx: PluginContext,
  repository: VpnProfileRepository,
) {
  return {
    async forHost(host: {
      id?: number | string;
      userId?: string | null;
    }): Promise<Socks5Config | null> {
      const hostId = Number(host.id);
      if (!Number.isInteger(hostId)) return null;

      const settings = await ctx.settings.getAll("host", hostId);
      const profileId = Number(settings.profileId);
      if (!Number.isInteger(profileId) || profileId <= 0) return null;

      /*
       * Whose profile this is has to be known, not assumed. Ids are small
       * integers and a profile reaches a gateway with stored credentials, so
       * resolving one without an owner would let a host carry someone else's
       * id and leave through their network.
       */
      if (!host.userId) {
        throw new Error(
          "This host is assigned to a VPN, but its owner is unknown",
        );
      }

      const profile = await repository.findById(profileId, host.userId);

      /*
       * Assigned to a network that no longer exists. Deleting a profile in
       * use is refused by the API, so reaching this means the row was
       * detached some other way -- and connecting anyway would put the
       * traffic on the server's own route, which is what the profile existed
       * to prevent.
       */
      if (!profile) {
        throw new Error("This host is assigned to a VPN that no longer exists");
      }

      return profileToConfig(profile);
    },

    /**
     * What a name means inside this host's network.
     *
     * A mesh names its members in terms that exist nowhere else, so the
     * network is asked rather than DNS. Null leaves the name alone, which is
     * right for an address that is already an IP and for a gateway that
     * keeps no list.
     */
    async resolveName(
      host: { id?: number | string; userId?: string | null },
      name: string,
    ): Promise<string | null> {
      const bare = String(name)
        .replace(/^\[|\]$/g, "")
        .trim();
      if (!bare || net.isIP(bare) !== 0) return null;

      const hostId = Number(host.id);
      if (!Number.isInteger(hostId) || !host.userId) return null;

      const settings = await ctx.settings.getAll("host", hostId);
      const profileId = Number(settings.profileId);
      if (!Number.isInteger(profileId) || profileId <= 0) return null;

      const profile = await repository.findById(profileId, host.userId);
      if (!profile || profile.kind !== "managed") return null;

      return resolveInManagedNetwork(profile.id, bare);
    },

    /**
     * Core no longer knows this is a VPN, and "Proxy connection failed" sends
     * someone who set a host's VPN looking in the wrong place.
     */
    describeFailure(error: unknown): string {
      return `VPN connection failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    },
  };
}
