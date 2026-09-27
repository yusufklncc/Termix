import net from "net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { openGatewayTunnel } from "../../hosts/gateway-tunnel.js";

/**
 * The tunnel exists so that guacd and the FreeRDP bridge, which take only a
 * host and a port, can still be sent through a network profile: it offers an
 * address, closing takes the address away again, and a doorway that is not
 * there is said so at the start instead of at the first connection.
 *
 * A doorway has to be standing for the first two, since opening now checks
 * that one answers. It need not speak SOCKS: the check is that something is
 * listening, not what it says.
 */
describe("openGatewayTunnel", () => {
  const opened: Array<{ close(): void }> = [];
  let doorway: net.Server;
  let doorwayPort: number;

  beforeAll(async () => {
    doorway = net.createServer(() => {});
    doorwayPort = await new Promise<number>((resolve) => {
      doorway.listen(0, "127.0.0.1", () =>
        resolve((doorway.address() as net.AddressInfo).port),
      );
    });
  });

  afterAll(() => doorway.close());

  afterEach(() => {
    for (const tunnel of opened.splice(0)) tunnel.close();
  });

  it("offers a local address the consumer can dial", async () => {
    const tunnel = await openGatewayTunnel({
      gateway: {
        useSocks5: true,
        socks5Host: "127.0.0.1",
        socks5Port: doorwayPort,
      },
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
      gateway: {
        useSocks5: true,
        socks5Host: "127.0.0.1",
        socks5Port: doorwayPort,
      },
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
      gateway: {
        useSocks5: true,
        socks5Host: "127.0.0.1",
        socks5Port: doorwayPort,
      },
      target: { host: "10.0.0.5", port: 3389 },
      endpoint: { bindHost: "127.0.0.1", advertisedHost: "127.0.0.1" },
    });
    tunnel.close();
    expect(() => tunnel.close()).not.toThrow();
  });

  it("refuses to open when the doorway is not there, and says why", async () => {
    // A port nothing listens on, which refuses at once. In practice the
    // sidecar's name stops resolving instead, which this same check catches
    // -- but a name that does not resolve takes as long as the resolver does,
    // and a test should not.
    await expect(
      openGatewayTunnel({
        gateway: { useSocks5: true, socks5Host: "127.0.0.1", socks5Port: 1 },
        target: { host: "10.0.0.5", port: 3389 },
        endpoint: { bindHost: "127.0.0.1", advertisedHost: "127.0.0.1" },
      }),
    ).rejects.toThrow(/gateway could not be reached/i);
  });
});
