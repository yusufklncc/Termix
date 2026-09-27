import { describe, expect, it } from "vitest";
import { createSocks5Connection } from "../../utils/socks5-helper.js";

/**
 * A proxy that was asked for and cannot be used has to fail the connection.
 *
 * The danger is not a failed connection -- it is a successful one. Callers set
 * `config.sock` only when this returns a socket, so a null return makes ssh2
 * dial the target directly, out of the server's own route. For a host that
 * exists precisely to keep traffic inside someone else's network, that is the
 * traffic leaving by the one path it was configured to avoid, silently.
 */
describe("createSocks5Connection fails closed", () => {
  it("returns null when the host does not use a proxy at all", async () => {
    await expect(
      createSocks5Connection("10.0.0.5", 22, { useSocks5: false }),
    ).resolves.toBeNull();
  });

  it("throws when a proxy is requested but no address is configured", async () => {
    await expect(
      createSocks5Connection("10.0.0.5", 22, { useSocks5: true }),
    ).rejects.toThrow(/no proxy address/i);
  });

  it("throws when the proxy address was cleared but the flag was left on", async () => {
    await expect(
      createSocks5Connection("10.0.0.5", 22, {
        useSocks5: true,
        socks5Host: "",
        socks5Port: 1080,
      }),
    ).rejects.toThrow(/no proxy address/i);
  });

  it("throws when a proxy chain is requested but empty", async () => {
    await expect(
      createSocks5Connection("10.0.0.5", 22, {
        useSocks5: true,
        socks5ProxyChain: [],
      }),
    ).rejects.toThrow();
  });
});
