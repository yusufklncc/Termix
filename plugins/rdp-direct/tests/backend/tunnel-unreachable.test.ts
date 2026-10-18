/**
 * What the screen says when core cannot reach the host.
 *
 * The bridge dials a local listener, never the host, so a host that cannot be
 * reached -- a VPN that is switched off, a profile that no longer exists, a
 * refused proxy -- reaches it as a connection that closed. What FreeRDP
 * reports for that is "transport layer failed", which names nothing and sends
 * the operator looking at the network. Core's own reason went to the Termix
 * log and nowhere else.
 */

import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import { openBridgeTunnel } from "../../src/backend/tunnel";
import type {
  PluginContext,
  PluginSshHost,
} from "@termix-ssh/plugin-sdk/backend";

const host = { id: 1, ip: "10.9.0.1", port: 3389 } as unknown as PluginSshHost;

function context(openTransport: () => Promise<void>) {
  const warn = vi.fn();
  const ctx = {
    log: { warn, info: vi.fn(), error: vi.fn() },
    ssh: { openTransport },
  } as unknown as PluginContext;
  return { ctx, warn };
}

/** One connection to the listener, which is what the bridge would make. */
function knock(port: number): Promise<void> {
  return new Promise((resolve) => {
    const socket = net.createConnection(port, "127.0.0.1", () => {
      socket.on("close", () => resolve());
      socket.on("error", () => resolve());
    });
    socket.on("error", () => resolve());
  });
}

describe("a host core cannot reach", () => {
  it("hands the caller core's own reason", async () => {
    const { ctx, warn } = context(async () => {
      throw new Error("This host's VPN is disabled");
    });
    const onUnreachable = vi.fn();

    const tunnel = await openBridgeTunnel({
      ctx,
      host,
      target: { host: "10.9.0.1", port: 3389 },
      bridgeHost: "127.0.0.1",
      onUnreachable,
    });

    await knock(tunnel.port);
    await vi.waitFor(() => expect(onUnreachable).toHaveBeenCalled());

    expect(onUnreachable).toHaveBeenCalledWith("This host's VPN is disabled");
    // Still logged, where it already was.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("This host's VPN is disabled"),
    );
    tunnel.close();
  });

  it("says it once, however many times the bridge tries", async () => {
    // The session is over after the first one; a second message would arrive
    // at a socket that is already closed.
    const { ctx } = context(async () => {
      throw new Error("no such VPN here");
    });
    const reasons: string[] = [];
    let announced = 0;
    const tunnel = await openBridgeTunnel({
      ctx,
      host,
      target: { host: "10.9.0.1", port: 3389 },
      bridgeHost: "127.0.0.1",
      // What session.ts does with it.
      onUnreachable: (reason) => {
        if (announced++) return;
        reasons.push(reason);
      },
    });

    await knock(tunnel.port);
    await knock(tunnel.port);
    await vi.waitFor(() => expect(announced).toBeGreaterThan(1));

    expect(reasons).toEqual(["no such VPN here"]);
    tunnel.close();
  });

  it("says nothing while the host can be reached", async () => {
    // Core had nothing in the way, and the port answers.
    const target = net.createServer((socket) => socket.destroy());
    const targetPort = await new Promise<number>((resolve) => {
      target.listen(0, "127.0.0.1", () =>
        resolve((target.address() as net.AddressInfo).port),
      );
    });

    const { ctx } = context(async () => {});
    const onUnreachable = vi.fn();
    const tunnel = await openBridgeTunnel({
      ctx,
      host,
      target: { host: "127.0.0.1", port: targetPort },
      bridgeHost: "127.0.0.1",
      onUnreachable,
    });

    await knock(tunnel.port);
    expect(onUnreachable).not.toHaveBeenCalled();
    tunnel.close();
    target.close();
  });

  it("reports a refused port rather than taking the backend down", async () => {
    /*
     * The plain dial had no error listener, so a host that is simply off
     * threw out of the event loop. Port 9 with nothing on it is that case.
     */
    const { ctx, warn } = context(async () => {});
    const onUnreachable = vi.fn();
    const tunnel = await openBridgeTunnel({
      ctx,
      host,
      target: { host: "127.0.0.1", port: 9 },
      bridgeHost: "127.0.0.1",
      onUnreachable,
    });

    await knock(tunnel.port);
    await vi.waitFor(() => expect(onUnreachable).toHaveBeenCalled());
    expect(onUnreachable).toHaveBeenCalledWith(
      expect.stringContaining("ECONNREFUSED"),
    );
    expect(warn).toHaveBeenCalled();
    tunnel.close();
  });
});
