/**
 * Fork: status checks for hosts that leave through a gateway -- a VPN the
 * vpn plugin raises, or the host's own SOCKS5 proxy.
 *
 * The status plugin dials a host's address itself unless the host has jump
 * hosts, and for a host behind a VPN that address only exists inside the
 * customer's network: dialled from the Termix server it reads as offline for
 * a machine that is up, and the packets leave by the very route the host was
 * configured to avoid. So core marks those hosts as routed (markGatewayRoutes)
 * and the status plugin asks ctx.ssh.probe for them, which lands here.
 *
 * Asking about a managed VPN that is down does not raise it: the status dot
 * polls every host every thirty seconds, and dialling the doorway would hold
 * every customer's network open for as long as anyone leaves the app open.
 */

import type { PluginHostProbeTarget } from "@termix-ssh/plugin-sdk/backend";
import {
  createSocks5Connection,
  type SOCKS5Config,
} from "../../utils/socks5-helper.js";
import type { HostStatusTargetRow } from "../../database/repositories/host-resolution-repository.js";

/** A host's proxy chain, which the column keeps as JSON text. */
function parseProxyChain(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Whether a TCP port answers through a SOCKS5 proxy.
 *
 * No banner is read. The proxy answering "connected" already means the
 * target port accepted, and a reply of any other kind is a refusal; reading
 * further would only keep someone else's network open for longer.
 */
export async function tcpPingThroughProxy(
  config: SOCKS5Config,
  host: string,
  port: number,
  timeoutMs = 5000,
): Promise<boolean> {
  const connecting = createSocks5Connection(host, port, config);
  // The connection that loses the race still finishes, and a socket nobody
  // holds keeps the tunnel's idle timer from ever firing.
  const discardLate = () => {
    void connecting.then((late) => late?.destroy()).catch(() => undefined);
  };

  let timer: NodeJS.Timeout | undefined;
  try {
    const socket = await Promise.race([
      connecting,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("proxy probe timed out")),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
    socket?.destroy();
    return socket !== null;
  } catch {
    discardLate();
    return false;
  } finally {
    clearTimeout(timer);
  }
}

type GatewayRow = Pick<HostStatusTargetRow, "id" | "userId" | "useSocks5">;

export interface GatewayProbeDeps {
  /** What this host leaves through, as the connect path would resolve it. */
  resolve: (host: Record<string, unknown>) => Promise<{
    config: SOCKS5Config;
    resolveName(name: string): Promise<string | null>;
    isUp(): Promise<boolean>;
  } | null>;
  /** The decrypted row, or null when nothing can decrypt it right now. */
  readOwnProxy: (
    hostId: number,
    userId: string,
  ) => Promise<Record<string, unknown> | null>;
  pingThroughProxy: typeof tcpPingThroughProxy;
}

const defaultDeps: GatewayProbeDeps = {
  resolve: async (host) => {
    const { resolveHostGateway } =
      await import("../../hosts/connect/host-gateway.js");
    return resolveHostGateway(host as never);
  },
  readOwnProxy: async (hostId, userId) => {
    const { createCurrentHostResolutionRepository } =
      await import("../../database/repositories/factory.js");
    const row = await createCurrentHostResolutionRepository()
      .findHostByIdForUser(hostId, userId)
      .catch(() => null);
    return row
      ? {
          ...row,
          socks5ProxyChain: parseProxyChain(
            (row as { socks5ProxyChain?: unknown }).socks5ProxyChain,
          ),
        }
      : null;
  },
  pingThroughProxy: tcpPingThroughProxy,
};

/**
 * How a probe of this host goes through its gateway.
 *
 * - undefined: the host has no gateway; dial it the ordinary way.
 * - null: it has one and it must not be dialled now -- the VPN is down or
 *   switched off, the profile is gone, or the proxy's password can't be
 *   read while its owner is signed out. Reported as offline.
 * - a boolean: the answer through the gateway.
 */
export async function probeThroughGateway(
  row: GatewayRow,
  target: { ip: string; port: number; timeoutMs: number },
  deps: GatewayProbeDeps = defaultDeps,
): Promise<boolean | null | undefined> {
  let host: Record<string, unknown> = { id: row.id, userId: row.userId };
  if (row.useSocks5) {
    const own = await deps.readOwnProxy(row.id, row.userId);
    if (!own) return null;
    host = own;
  }

  let gateway: Awaited<ReturnType<GatewayProbeDeps["resolve"]>>;
  try {
    gateway = await deps.resolve(host);
  } catch {
    // "This host's VPN is disabled", "that profile is gone": the route was
    // meant to be used and can't be, which is not the host having none.
    return null;
  }
  if (!gateway) return undefined;
  if (!(await gateway.isUp().catch(() => false))) return null;
  // A name that only exists inside that network is resolved by it.
  const address =
    (await gateway.resolveName(target.ip).catch(() => null)) ?? target.ip;
  return deps.pingThroughProxy(
    gateway.config,
    address,
    target.port,
    target.timeoutMs,
  );
}

/**
 * Whether the host leaves through a gateway, so the status plugin should ask
 * core about it rather than dial its address. A gateway that refuses (a VPN
 * switched off) still counts: that host must not be dialled directly either.
 */
export async function leavesThroughGateway(
  row: GatewayRow,
  deps: Pick<GatewayProbeDeps, "resolve"> = defaultDeps,
): Promise<boolean> {
  if (row.useSocks5) return true;
  try {
    return (await deps.resolve({ id: row.id, userId: row.userId })) !== null;
  } catch {
    return true;
  }
}

/**
 * Lists a gateway-routed host with itself as its one hop.
 *
 * The status plugin reads only whether jumpHosts is empty: empty, it dials
 * the address; not, it asks ctx.ssh.probe with the host's id, and core
 * reads the host's real route from the database again. Nothing follows the
 * hop itself.
 */
export async function markGatewayRoutes(
  rows: GatewayRow[],
  targets: PluginHostProbeTarget[],
  deps: Pick<GatewayProbeDeps, "resolve"> = defaultDeps,
): Promise<PluginHostProbeTarget[]> {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return Promise.all(
    targets.map(async (target) => {
      const row = byId.get(target.id);
      if (!row || target.jumpHosts.length > 0) return target;
      return (await leavesThroughGateway(row, deps))
        ? { ...target, jumpHosts: [{ hostId: target.id }] }
        : target;
    }),
  );
}
