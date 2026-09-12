import net from "net";
import { createJumpHostChain } from "../jump-host-chain.js";
import { resolveJumpTunnelEndpoint } from "../guacamole/jump-tunnel-endpoint.js";
import { sshLogger } from "../../utils/logger.js";

/**
 * SSH tunnelling for the direct RDP path.
 *
 * The bridge dials a host and port; it knows nothing about jump hosts. So the
 * hops are dialled here and a local listener forwards into the chain, and the
 * bridge is handed that listener instead of the real target.
 *
 * This is how the guacd path already does it, and the endpoint helper is shared
 * with it rather than reimplemented: the bind address depends on whether the
 * consumer is in this process's network namespace or another container, which
 * is the same question either way.
 */

export interface JumpHostRef {
  hostId: number;
}

export interface JumpTunnel {
  /** What the bridge should dial instead of the target. */
  host: string;
  port: number;
  close(): void;
}

/**
 * Reads the host's stored jump host list.
 *
 * A malformed value means no tunnel rather than a failed session: the column is
 * written by the UI and an unreadable one should not lock a host out.
 */
export function parseJumpHosts(value: unknown): JumpHostRef[] {
  if (!value) return [];
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is JumpHostRef =>
        !!entry &&
        typeof entry === "object" &&
        Number.isInteger((entry as JumpHostRef).hostId),
    );
  } catch {
    return [];
  }
}

/**
 * Opens a tunnel to `target` through `jumpHosts` and returns what to dial.
 *
 * Returns null when there are no jump hosts, which is the common case and not
 * a failure. Throws when a chain is configured and cannot be established --
 * connecting straight to the target would bypass the hops the host was
 * deliberately configured to require.
 */
export async function openJumpTunnel({
  jumpHosts,
  userId,
  target,
  consumerHost,
  tunnelHost = process.env.RDP_BRIDGE_TUNNEL_HOST,
}: {
  jumpHosts: JumpHostRef[];
  userId: string;
  target: { host: string; port: number };
  /** Where the bridge runs, which decides what the listener may bind to. */
  consumerHost: string;
  tunnelHost?: string;
}): Promise<JumpTunnel | null> {
  if (jumpHosts.length === 0) return null;

  const endpoint = resolveJumpTunnelEndpoint(consumerHost, tunnelHost);
  const client = await createJumpHostChain(jumpHosts, userId);
  if (!client) {
    throw new Error("Failed to establish the jump host chain");
  }

  const server = net.createServer((socket) => {
    client.forwardOut(
      "127.0.0.1",
      0,
      target.host,
      target.port,
      (error, stream) => {
        if (error) {
          socket.destroy();
          return;
        }
        socket.pipe(stream).pipe(socket);
      },
    );
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
      // Tied to the session rather than a timer: when the socket goes, so do
      // the listener and the hops behind it.
      if (closed) return;
      closed = true;
      server.close();
      try {
        client.end();
      } catch (error) {
        sshLogger.warn("Failed to close a jump host chain", {
          operation: "rdp_direct_tunnel_close_error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
