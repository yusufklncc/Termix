import net from "node:net";
import type { Duplex } from "node:stream";
import type { PluginContext, PluginSshHost } from "@termix/plugin-sdk/backend";
import { resolveTunnelEndpoint } from "./tunnel-endpoint.js";

export interface BridgeTunnel {
  /** What the bridge should dial instead of the target. */
  host: string;
  port: number;
  close(): void;
}

/**
 * Does reaching this host take more than dialling it?
 *
 * Jump hosts and a VPN are the two answers core knows about, and the bridge
 * can act on neither: it takes a host and a port and opens a plain TCP
 * connection. So when either is set the connection is made here instead.
 */
export function needsTunnel(host: Record<string, unknown>): boolean {
  const jumpHosts = host.jumpHosts;
  const hops = Array.isArray(jumpHosts) ? jumpHosts.length : 0;
  return hops > 0 || host.vpnProfileId != null;
}

/**
 * A local address that comes out wherever the host actually is.
 *
 * Each connection to the listener asks core for a transport to the host and
 * pipes the two together. Core already decides what that means -- port
 * knocking, a jump host chain, the VPN's gateway -- so there is one answer
 * here rather than one per kind of detour, and a path this plugin never
 * learned about still works.
 *
 * A host that needs a detour and cannot get one fails the session. Dialling
 * the target directly instead would ignore the very thing it was configured
 * to require.
 */
export async function openBridgeTunnel({
  ctx,
  host,
  target,
  bridgeHost,
}: {
  ctx: PluginContext;
  host: PluginSshHost;
  target: { host: string; port: number };
  /** Where the bridge runs, which decides what the listener may bind to. */
  bridgeHost: string;
}): Promise<BridgeTunnel> {
  const endpoint = resolveTunnelEndpoint(bridgeHost);
  const open = new Set<Duplex>();

  const server = net.createServer((socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));

    void (async () => {
      // The target's address is already known, so there is nothing here for
      // core to look up -- and a name that only resolves on the far side
      // would fail if it tried.
      const config: Record<string, unknown> = {};
      try {
        await ctx.ssh.openTransport({ ...host, ...target }, config, {
          resolveDns: false,
        });
      } catch (error) {
        ctx.log.warn(
          `Direct RDP could not reach ${target.host}:${target.port}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        socket.destroy();
        return;
      }

      const upstream = config.sock as Duplex | undefined;
      if (!upstream) {
        // Core found nothing in the way after all; dial it plainly.
        const direct = net.createConnection(target.port, target.host);
        open.add(direct);
        direct.on("close", () => open.delete(direct));
        socket.pipe(direct).pipe(socket);
        return;
      }

      open.add(upstream);
      upstream.on("close", () => open.delete(upstream));
      socket.pipe(upstream).pipe(socket);
    })();
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, endpoint.bindHost, () => {
      resolve((server.address() as net.AddressInfo).port);
    });
  });

  let closed = false;
  return {
    host: endpoint.advertisedHost,
    port,
    close() {
      // Tied to the session rather than a timer: when the viewer's socket
      // goes, so do the listener and everything behind it.
      if (closed) return;
      closed = true;
      server.close();
      for (const socket of open) socket.destroy();
      open.clear();
    },
  };
}
