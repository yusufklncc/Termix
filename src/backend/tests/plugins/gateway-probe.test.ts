/**
 * Fork: status checks for hosts behind a VPN or their own proxy.
 *
 * Since 26.11 the status dot is a plugin that dials a host's address itself
 * unless the host has jump hosts. For a host behind a customer's VPN that
 * address only exists inside their network: dialled from the server it reads
 * offline for a machine that is up, and the packets leave by the route the
 * host was configured to avoid. Core now marks those hosts so the plugin asks
 * ctx.ssh.probe, and answers through the gateway.
 */

import type net from "node:net";
import { describe, expect, it, vi } from "vitest";

const createSocks5Connection = vi.fn();
vi.mock("../../utils/socks5-helper.js", () => ({
  createSocks5Connection: (...args: unknown[]) =>
    createSocks5Connection(...args),
}));

const {
  leavesThroughGateway,
  markGatewayRoutes,
  probeThroughGateway,
  tcpPingThroughProxy,
} = await import("../../plugins/probe/gateway-probe.js");

const config = { useSocks5: true, socks5Host: "netmgr", socks5Port: 20007 };
const target = { ip: "10.9.0.4", port: 22, timeoutMs: 5000 };

function gateway(
  overrides: Partial<{ up: boolean; name: string | null }> = {},
) {
  return {
    config,
    isUp: vi.fn(async () => overrides.up ?? true),
    resolveName: vi.fn(async () => overrides.name ?? null),
  };
}

function deps(resolved: unknown, ping = true) {
  return {
    resolve: vi.fn(async () => {
      if (resolved instanceof Error) throw resolved;
      return resolved as ReturnType<typeof gateway> | null;
    }),
    readOwnProxy: vi.fn(async () => null),
    pingThroughProxy: vi.fn(async () => ping),
  };
}

describe("tcpPingThroughProxy", () => {
  it("is online when the proxy places the connection, and lets go of it", async () => {
    const socket = { destroy: vi.fn() } as unknown as net.Socket;
    createSocks5Connection.mockResolvedValue(socket);
    await expect(tcpPingThroughProxy(config, "10.9.0.4", 22)).resolves.toBe(
      true,
    );
    expect(createSocks5Connection).toHaveBeenCalledWith("10.9.0.4", 22, config);
    // Held open, this is what stops the tunnel ever going idle.
    expect(socket.destroy).toHaveBeenCalledOnce();
  });

  it("is offline when the proxy refuses", async () => {
    createSocks5Connection.mockRejectedValue(new Error("connection refused"));
    await expect(tcpPingThroughProxy(config, "10.9.0.4", 22)).resolves.toBe(
      false,
    );
  });

  it("gives up after the timeout, and closes what arrives late", async () => {
    vi.useFakeTimers();
    const socket = { destroy: vi.fn() } as unknown as net.Socket;
    let place: (value: net.Socket) => void = () => {};
    createSocks5Connection.mockReturnValue(
      new Promise<net.Socket>((resolve) => {
        place = resolve;
      }),
    );
    const result = tcpPingThroughProxy(config, "10.9.0.4", 22, 5000);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(result).resolves.toBe(false);
    place(socket);
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.destroy).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});

describe("a host that leaves through a VPN", () => {
  const row = { id: 7, userId: "alice", useSocks5: false };

  it("is asked through it, by the name the network gives it", async () => {
    const d = deps(gateway({ name: "100.64.0.9" }));
    await expect(probeThroughGateway(row, target, d)).resolves.toBe(true);
    expect(d.resolve).toHaveBeenCalledWith({ id: 7, userId: "alice" });
    expect(d.pingThroughProxy).toHaveBeenCalledWith(
      config,
      "100.64.0.9",
      22,
      5000,
    );
  });

  it("is offline when the port does not answer through it", async () => {
    const d = deps(gateway(), false);
    await expect(probeThroughGateway(row, target, d)).resolves.toBe(false);
  });

  it("is not dialled while the VPN is down, which would raise it", async () => {
    const d = deps(gateway({ up: false }));
    await expect(probeThroughGateway(row, target, d)).resolves.toBeNull();
    expect(d.pingThroughProxy).not.toHaveBeenCalled();
  });

  it("is not dialled at all when the VPN refuses it", async () => {
    const d = deps(new Error("This host's VPN is disabled"));
    await expect(probeThroughGateway(row, target, d)).resolves.toBeNull();
    expect(d.pingThroughProxy).not.toHaveBeenCalled();
  });
});

describe("a host with its own proxy", () => {
  const row = { id: 8, userId: "alice", useSocks5: true };

  it("is probed through it, with the decrypted row", async () => {
    const d = deps(gateway());
    const decrypted = { id: 8, userId: "alice", socks5Password: "pw" };
    d.readOwnProxy.mockResolvedValue(decrypted as never);
    await expect(probeThroughGateway(row, target, d)).resolves.toBe(true);
    expect(d.readOwnProxy).toHaveBeenCalledWith(8, "alice");
    expect(d.resolve).toHaveBeenCalledWith(decrypted);
  });

  it("is left unasked while its row can't be decrypted", async () => {
    const d = deps(gateway());
    await expect(probeThroughGateway(row, target, d)).resolves.toBeNull();
    expect(d.resolve).not.toHaveBeenCalled();
    expect(d.pingThroughProxy).not.toHaveBeenCalled();
  });
});

describe("a host with no gateway", () => {
  it("is left to the ordinary probe, and no row is read", async () => {
    const d = deps(null);
    await expect(
      probeThroughGateway(
        { id: 9, userId: "alice", useSocks5: false },
        target,
        d,
      ),
    ).resolves.toBeUndefined();
    expect(d.readOwnProxy).not.toHaveBeenCalled();
  });
});

describe("the targets the status plugin is given", () => {
  const probe = (id: number, jumpHosts: Array<{ hostId: number }> = []) => ({
    id,
    ownerUserId: "alice",
    ip: "10.9.0.4",
    port: 22,
    connectionType: "ssh",
    jumpHosts,
    statusCheckEnabled: true,
    statusCheckInterval: null,
  });

  it("send gateway hosts to ctx.ssh.probe and leave the rest alone", async () => {
    const resolve = vi.fn(async (host: Record<string, unknown>) => {
      if (host.id === 1) return gateway();
      if (host.id === 2) throw new Error("no such VPN here");
      return null;
    });
    const rows = [1, 2, 3, 4, 5].map((id) => ({
      id,
      userId: "alice",
      useSocks5: id === 4,
    }));
    const marked = await markGatewayRoutes(
      rows,
      [probe(1), probe(2), probe(3), probe(4), probe(5, [{ hostId: 40 }])],
      { resolve },
    );
    expect(marked.map((t) => t.jumpHosts)).toEqual([
      [{ hostId: 1 }], // VPN
      [{ hostId: 2 }], // a VPN that refuses: still not dialled directly
      [], // nothing in the way
      [{ hostId: 4 }], // its own proxy
      [{ hostId: 40 }], // real jump hosts, untouched
    ]);
  });

  it("count a host with its own proxy without asking anyone", async () => {
    const resolve = vi.fn();
    await expect(
      leavesThroughGateway(
        { id: 4, userId: "a", useSocks5: true },
        { resolve },
      ),
    ).resolves.toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });
});
