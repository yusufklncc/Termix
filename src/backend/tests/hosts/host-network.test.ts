import { describe, expect, it } from "vitest";
import { resolveHostGateway } from "../../hosts/host-network.js";
import type { VpnProfileRecord } from "../../database/repositories/vpn-profile-repository.js";

const profile = (over: Partial<VpnProfileRecord> = {}) =>
  ({
    id: 1,
    userId: "user-1",
    name: "Company X",
    description: null,
    folder: null,
    tags: null,
    kind: "declared",
    gatewayType: "socks5",
    gatewayHost: "vpn-x",
    gatewayPort: 1080,
    gatewayUsername: null,
    gatewayPassword: null,
    createdAt: "",
    updatedAt: "",
    ...over,
  }) as VpnProfileRecord;

const never = async () => {
  throw new Error("should not load a profile");
};

describe("resolveHostGateway", () => {
  it("returns null only when the host wants a direct connection", async () => {
    await expect(resolveHostGateway({}, never)).resolves.toBeNull();
    await expect(
      resolveHostGateway({ useSocks5: false }, never),
    ).resolves.toBeNull();
  });

  it("uses the host's own proxy when it has an address", async () => {
    const config = await resolveHostGateway(
      { useSocks5: true, socks5Host: "10.0.0.9", socks5Port: 1080 },
      never,
    );
    expect(config?.socks5Host).toBe("10.0.0.9");
  });

  it("throws when a proxy is asked for with no address", async () => {
    // The seven call sites used to build null here and connect directly.
    await expect(
      resolveHostGateway({ useSocks5: true }, never),
    ).rejects.toThrow(/no proxy address/i);
    await expect(
      resolveHostGateway({ useSocks5: true, socks5Host: "  " }, never),
    ).rejects.toThrow(/no proxy address/i);
    await expect(
      resolveHostGateway({ useSocks5: true, socks5ProxyChain: [] }, never),
    ).rejects.toThrow(/no proxy address/i);
  });

  it("routes a host through its network profile", async () => {
    const config = await resolveHostGateway({ vpnProfileId: 1 }, async () =>
      profile({ gatewayHost: "vpn-x", gatewayPort: 1080 }),
    );
    expect(config?.socks5Host).toBe("vpn-x");
    expect(config?.socks5Port).toBe(1080);
  });

  it("expresses an HTTP gateway as a one-node chain", async () => {
    const config = await resolveHostGateway({ vpnProfileId: 1 }, async () =>
      profile({ gatewayType: "http", gatewayHost: "vpn-y", gatewayPort: 3128 }),
    );
    expect(config?.socks5ProxyChain).toEqual([
      {
        host: "vpn-y",
        port: 3128,
        type: "http",
        username: undefined,
        password: undefined,
      },
    ]);
  });

  it("throws when the assigned profile is gone", async () => {
    // Deleting a profile in use is refused, so this means the row was
    // detached some other way. Connecting would use the server's own route.
    await expect(
      resolveHostGateway({ vpnProfileId: 7 }, async () => null),
    ).rejects.toThrow(/no longer exists/i);
  });

  it("prefers the profile when a host also carries its own proxy", async () => {
    const config = await resolveHostGateway(
      { vpnProfileId: 1, useSocks5: true, socks5Host: "10.0.0.9" },
      async () => profile({ gatewayHost: "vpn-x" }),
    );
    expect(config?.socks5Host).toBe("vpn-x");
  });
});
