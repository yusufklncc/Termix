import net from "net";
import { afterEach, describe, expect, it } from "vitest";
import { openGatewayTunnel } from "../../hosts/gateway-tunnel.js";

/**
 * The tunnel exists so that guacd and the FreeRDP bridge, which take only a
 * host and a port, can still be sent through a network profile. These cover
 * the part that does not need a SOCKS server standing by: that it offers an
 * address, and that closing it takes the address away again.
 */
describe("openGatewayTunnel", () => {
  const opened: Array<{ close(): void }> = [];

  afterEach(() => {
    for (const tunnel of opened.splice(0)) tunnel.close();
  });

  it("offers a local address the consumer can dial", async () => {
    const tunnel = await openGatewayTunnel({
      gateway: { useSocks5: true, socks5Host: "127.0.0.1", socks5Port: 1080 },
      target: { host: "10.0.0.5", port: 3389 },
      endpoint: { bindHost: "127.0.0.1", advertisedHost: "127.0.0.1" },
    });
    opened.push(tunnel);

    expect(tunnel.host).toBe("127.0.0.1");
    expect(tunnel.port).toBeGreaterThan(0);

    await new Promise<void>((resolve, reject) => {
      const probe = net
        .connect(tunnel.port, "127.0.0.1")
        .on("connect", () => {
          probe.destroy();
          resolve();
        })
        .on("error", reject);
    });
  });

  it("stops listening once closed", async () => {
    const tunnel = await openGatewayTunnel({
      gateway: { useSocks5: true, socks5Host: "127.0.0.1", socks5Port: 1080 },
      target: { host: "10.0.0.5", port: 3389 },
      endpoint: { bindHost: "127.0.0.1", advertisedHost: "127.0.0.1" },
    });
    const { port } = tunnel;
    tunnel.close();

    // close() stops the listener a tick later, so this waits for the port to
    // start refusing rather than asserting on the instant after the call.
    const refused = async () => {
      for (let attempt = 0; attempt < 50; attempt++) {
        const ok = await new Promise<boolean>((resolve) => {
          const probe = net
            .connect(port, "127.0.0.1")
            .on("connect", () => {
              probe.destroy();
              resolve(true);
            })
            .on("error", () => resolve(false));
        });
        if (!ok) return true;
        await new Promise((r) => setTimeout(r, 10));
      }
      return false;
    };

    expect(await refused()).toBe(true);
  });

  it("is safe to close twice", async () => {
    const tunnel = await openGatewayTunnel({
      gateway: { useSocks5: true, socks5Host: "127.0.0.1", socks5Port: 1080 },
      target: { host: "10.0.0.5", port: 3389 },
      endpoint: { bindHost: "127.0.0.1", advertisedHost: "127.0.0.1" },
    });
    tunnel.close();
    expect(() => tunnel.close()).not.toThrow();
  });
});
