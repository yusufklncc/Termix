/**
 * How the tunnel asks core for the route.
 *
 * In a plugin process (Termix 26.11 and later) core only hands over the
 * config's host and port, and holds every byte until the far end greets as
 * an SSH server unless the stream is marked raw. RDP never greets: without
 * these two the session hung on an open socket, direct hosts included.
 */

import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import { openBridgeTunnel } from "../../src/backend/tunnel";
import type {
  PluginContext,
  PluginSshHost,
} from "@termix-ssh/plugin-sdk/backend";

const host = { id: 1, ip: "10.9.0.1", port: 3389 } as unknown as PluginSshHost;

describe("the route core is asked for", () => {
  it("names the RDP target and asks for a raw stream", async () => {
    const openTransport = vi.fn(async () => ({
      jumpClient: null,
      via: "proxy",
    }));
    const ctx = {
      log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      ssh: { openTransport },
    } as unknown as PluginContext;

    const tunnel = await openBridgeTunnel({
      ctx,
      host,
      target: { host: "10.9.0.1", port: 3389 },
      bridgeHost: "127.0.0.1",
    });
    const socket = net.createConnection(tunnel.port, "127.0.0.1");
    socket.on("error", () => {});
    await vi.waitFor(() => expect(openTransport).toHaveBeenCalled());

    const [, config, options] = openTransport.mock.calls[0] as unknown as [
      unknown,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(config).toMatchObject({ host: "10.9.0.1", port: 3389 });
    expect(options).toMatchObject({ raw: true, resolveDns: false });

    socket.destroy();
    tunnel.close();
  });
});
