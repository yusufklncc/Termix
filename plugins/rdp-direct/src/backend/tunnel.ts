import net from "node:net";
import type { Duplex } from "node:stream";
import type {
  PluginContext,
  PluginSshHost,
} from "@termix-ssh/plugin-sdk/backend";
import { resolveTunnelEndpoint } from "./tunnel-endpoint.js";

export interface BridgeTunnel {
  /** What the bridge should dial instead of the target. */
  host: string;
  port: number;
  close(): void;
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
 * Always opened, rather than only where a detour is known to be needed.
 * Whether one is -- a jump chain, a VPN a plugin raises -- is core's to
 * answer and it answers per connection, so asking up front would mean
 * guessing, and guessing wrong means the bridge dialling an address that
 * only exists on the far side of a tunnel. A host with nothing in the way
 * costs one hop inside this process, which against an H.264 stream is
 * nothing.
 *
 * A host that needs a detour and cannot get one fails that connection.
 * Dialling the target directly instead would ignore the very thing it was
 * configured to require.
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
