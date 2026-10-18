import net from "node:net";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import {
  managedDoorPassword,
  managedDoorPort,
  MANAGED_DOORWAY_USER,
  listManagedNetworks,
  resolveInManagedNetwork,
  resolveNetManagerOptions,
} from "./net-manager-client.js";
import { assertSecretsReadable } from "./legacy-secrets.js";
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
  // Before anything is dialled with them.
  assertSecretsReadable(profile);

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
      // The doorway asks for these before it raises anything. Both sides
      // derive them from the manager's token, so neither stores them.
      socks5Username: MANAGED_DOORWAY_USER,
      socks5Password: managedDoorPassword(profile.id, manager.token),
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
 * Which managed networks are up, asked once for a burst of questions.
 *
 * The status dot asks for every host at the same moment, every interval, and
 * the answer is the same for all of them. A second is short enough that a
 * tunnel raised for a session is seen on the next poll.
 */
const STATE_TTL_MS = 1000;
let stateCache: { at: number; networks: Promise<Set<number>> } | null = null;

function networksUp(): Promise<Set<number>> {
  const now = Date.now();
  if (stateCache && now - stateCache.at < STATE_TTL_MS) {
    return stateCache.networks;
  }
  const networks = listManagedNetworks().then(
    (states) =>
      new Set(
        (states ?? [])
          .filter((state) => state.state === "up")
          .map((state) => state.id),
      ),
  );
  stateCache = { at: now, networks };
  return networks;
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
  /**
   * Which network this host leaves through.
   *
   * The host carries both the profile's id and its name. The id is the fast
   * answer and the name is the true one: an id means "the nth profile of the
   * account that wrote it", so a host imported from somewhere else would
   * point at whatever is nth here. When the two disagree, or the id resolves
   * to nothing, the name decides.
   *
   * Null means this plugin has nothing to say and core reads the host's own
   * proxy fields. A host that names a network nobody here has is refused
   * instead -- it was configured to avoid the server's own route, and
   * connecting anyway would take exactly that route.
   */
  async function resolveProfile(host: {
    id?: number | string;
    userId?: string | null;
  }): Promise<VpnProfileRecord | null> {
    const hostId = Number(host.id);
    if (!Number.isInteger(hostId)) return null;

    const settings = await ctx.settings.getAll("host", hostId);
    const profileId = Number(settings.profileId);
    const profileName =
      typeof settings.profileName === "string" && settings.profileName.trim()
        ? settings.profileName.trim()
        : null;
    const hasId = Number.isInteger(profileId) && profileId > 0;
    if (!hasId && !profileName) return null;

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

    if (hasId) {
      const byId = await repository.findById(profileId, host.userId);
      // The name confirms the id belongs to the network that was meant.
      if (byId && (!profileName || byId.name === profileName)) return byId;
    }

    if (profileName) {
      const byName = await repository.findByName(profileName, host.userId);
      if (byName) return byName;
      throw new Error(
        `This host is assigned to a VPN named "${profileName}", and there is no such VPN here`,
      );
    }

    /*
     * An id that resolves to nothing, with no name to fall back on. Deleting
     * a profile in use is refused by the API, so reaching this means the row
     * was detached some other way -- and connecting anyway would put the
     * traffic on the server's own route, which is what the profile existed
     * to prevent.
     */
    throw new Error("This host is assigned to a VPN that no longer exists");
  }

  return {
    async forHost(host: {
      id?: number | string;
      userId?: string | null;
    }): Promise<Socks5Config | null> {
      const profile = await resolveProfile(host);
      return profile ? profileToConfig(profile) : null;
    },

    /**
     * Whether this host's doorway can be dialled without raising anything.
     *
     * Only the status dot asks. Connecting to a managed doorway is what
     * raises the tunnel, and the dot asks every thirty seconds for every
     * host -- so answering "yes" while the tunnel is down would hold every
     * customer's network open for as long as somebody leaves the app open,
     * and the manager's idle timer would never fire.
     *
     * A gateway somebody else runs is always dialable: nothing of ours
     * raises it, and it is up or it is not.
     */
    async isUp(host: {
      id?: number | string;
      userId?: string | null;
    }): Promise<boolean> {
      const profile = await resolveProfile(host).catch(() => null);
      if (!profile) return true;
      if (profile.kind !== "managed") return true;
      return (await networksUp()).has(profile.id);
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

      const profile = await resolveProfile(host).catch(() => null);
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
