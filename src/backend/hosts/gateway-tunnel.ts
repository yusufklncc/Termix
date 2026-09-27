import net from "net";
import { createSocks5Connection } from "../utils/socks5-helper.js";
import type { SOCKS5Config } from "../utils/proxy-helper.js";
import { resolveJumpTunnelEndpoint } from "./guacamole/jump-tunnel-endpoint.js";
import { sshLogger } from "../utils/logger.js";
import { getErrorMessage } from "../utils/error-message.js";

/**
 * A local address that comes out inside another network.
 *
 * The SSH paths can be handed a socket, so a host's network profile is
 * applied by opening the connection through its gateway. The remote desktop
 * paths cannot: guacd and the FreeRDP bridge dial their own targets, and both
 * take only a host and a port.
 *
 * So they are given one. This listens locally, and every connection to it is
 * carried through the gateway to the real target -- the same trick the jump
 * host tunnel already uses, which is why the bind address is worked out by
 * the same helper: what the listener may bind to depends on whether the
 * consumer shares this process's network namespace or is another container.
 */

export interface GatewayTunnel {
  /** What the consumer should dial instead of the real target. */
  host: string;
  port: number;
  close(): void;
}

/**
 * Is the doorway even there?
 *
 * Without this the listener opens regardless, and a doorway that is gone is
 * only discovered when the consumer dials -- as a connection that opens and
 * closes with nothing said. guacd and the bridge report that as a generic
 * failure, so the operator is told the host is unreachable and not that the
 * network its traffic should have taken is down.
 *
 * One connect to the gateway, at session start, buys the reason.
 */
async function assertGatewayReachable(
  gateway: SOCKS5Config,
  timeoutMs = 5000,
): Promise<void> {
  const chain = gateway.socks5ProxyChain;
  const first =
    Array.isArray(chain) && chain.length > 0
      ? { host: chain[0].host, port: chain[0].port }
      : gateway.socks5Host
        ? { host: gateway.socks5Host, port: gateway.socks5Port ?? 1080 }
        : null;

  // The resolver never hands back a gateway without an address, so there is
  // nothing here to check rather than something to complain about.
  if (!first) return;

  await new Promise<void>((resolve, reject) => {
    const socket = net.connect(first.port, first.host);
    const settle = (error?: Error) => {
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(timeoutMs, () =>
      settle(new Error(`timed out reaching ${first.host}:${first.port}`)),
    );
    socket.once("connect", () => settle());
    socket.once("error", (error) => settle(error));
  });
}

export async function openGatewayTunnel({
  gateway,
  target,
  consumerHost,
  tunnelHost = process.env.RDP_BRIDGE_TUNNEL_HOST,
  endpoint: providedEndpoint,
}: {
  gateway: SOCKS5Config;
  target: { host: string; port: number };
  /** Where the consumer runs, which decides what the listener may bind to. */
  consumerHost?: string;
  tunnelHost?: string;
  /** Already worked out by the caller, as the guacd path does for its own
   * tunnels. Given one, this does not resolve it again. */
  endpoint?: { bindHost: string; advertisedHost: string };
}): Promise<GatewayTunnel> {
  const endpoint =
    providedEndpoint ??
    resolveJumpTunnelEndpoint(consumerHost ?? "", tunnelHost);

  try {
    await assertGatewayReachable(gateway);
  } catch (error) {
    throw new Error(
      `the network's gateway could not be reached: ${getErrorMessage(error)}`,
      { cause: error },
    );
  }

  const server = net.createServer((socket) => {
    createSocks5Connection(target.host, target.port, gateway)
      .then((upstream) => {
        // The resolver throws rather than returning null for a gateway that
        // cannot be used, so this is only reachable if one is handed in with
        // nothing configured. Dropping the connection is the safe reading.
        if (!upstream) {
          socket.destroy();
          return;
        }
        socket.pipe(upstream).pipe(socket);
      })
      .catch((error) => {
        sshLogger.error("Gateway tunnel connection failed", error, {
          operation: "gateway_tunnel_connect_error",
          targetHost: target.host,
          targetPort: target.port,
        });
        socket.destroy();
      });
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
      // Tied to the session rather than a timer: when the session goes, so
      // does the way into that network.
      if (closed) return;
      closed = true;
      server.close();
    },
  };
}
