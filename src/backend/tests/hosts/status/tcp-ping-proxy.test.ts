/**
 * Probing a host from the far side of a proxy.
 *
 * The socket matters as much as the answer: the manager drops a tunnel five
 * minutes after its last connection closes, so a probe that left its socket
 * behind would keep that network up for as long as the app is open.
 */

import type net from "node:net";
import { describe, expect, it, vi } from "vitest";

const createSocks5Connection = vi.fn();
vi.mock("../../../utils/socks5-helper.js", () => ({
  createSocks5Connection: (...args: unknown[]) =>
    createSocks5Connection(...args),
}));

const { tcpPingThroughProxy } =
  await import("../../../hosts/status/tcp-ping.js");

const config = { useSocks5: true, socks5Host: "netmgr", socks5Port: 20007 };

describe("tcpPingThroughProxy", () => {
  it("is online when the proxy places the connection", async () => {
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

    // The proxy answers after nobody is waiting for it.
    place(socket);
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.destroy).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
