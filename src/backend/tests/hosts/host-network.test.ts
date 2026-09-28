import { describe, expect, it } from "vitest";
import {
  gatewayFailureMessage,
  hostNetworkFields,
  resolveHostGateway,
} from "../../hosts/host-network.js";
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
    const config = await resolveHostGateway(
      { vpnProfileId: 1, userId: "user-1" },
      async () => profile({ gatewayHost: "vpn-x", gatewayPort: 1080 }),
    );
    expect(config?.socks5Host).toBe("vpn-x");
    expect(config?.socks5Port).toBe(1080);
  });

  it("expresses an HTTP gateway as a one-node chain", async () => {
    const config = await resolveHostGateway(
      { vpnProfileId: 1, userId: "user-1" },
      async () =>
        profile({
          gatewayType: "http",
          gatewayHost: "vpn-y",
          gatewayPort: 3128,
        }),
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
      resolveHostGateway(
        { vpnProfileId: 7, userId: "user-1" },
        async () => null,
      ),
    ).rejects.toThrow(/no longer exists/i);
  });

  it("prefers the profile when a host also carries its own proxy", async () => {
    const config = await resolveHostGateway(
      {
        vpnProfileId: 1,
        userId: "user-1",
        useSocks5: true,
        socks5Host: "10.0.0.9",
      },
      async () => profile({ gatewayHost: "vpn-x" }),
    );
    expect(config?.socks5Host).toBe("vpn-x");
  });
});

describe("gatewayFailureMessage", () => {
  it("names the VPN for a host reached through one", () => {
    expect(
      gatewayFailureMessage(
        { vpnProfileId: 2, userId: "user-1" },
        new Error("ENOTFOUND"),
      ),
    ).toBe("VPN connection failed: ENOTFOUND");
  });

  it("still says proxy for a host that uses one", () => {
    expect(gatewayFailureMessage({}, new Error("ECONNREFUSED"))).toBe(
      "Proxy connection failed: ECONNREFUSED",
    );
  });
});

describe("hostNetworkFields", () => {
  it("carries a host's network profile", () => {
    expect(hostNetworkFields({ vpnProfileId: 3 }).vpnProfileId).toBe(3);
  });

  it("carries a host's own proxy, chain and all", () => {
    const chain = [{ type: "socks5", host: "a", port: 1 }];
    const fields = hostNetworkFields({
      useSocks5: true,
      socks5Host: "proxy",
      socks5Port: 1080,
      socks5Username: "u",
      socks5Password: "p",
      socks5ProxyChain: chain,
    } as never);
    expect(fields).toMatchObject({
      useSocks5: true,
      socks5Host: "proxy",
      socks5Port: 1080,
      socks5Username: "u",
      socks5Password: "p",
      socks5ProxyChain: chain,
    });
  });

  it("drops a chain that is not one, as the resolver would", () => {
    expect(
      hostNetworkFields({ socks5ProxyChain: "[]" }).socks5ProxyChain,
    ).toBeUndefined();
  });

  /**
   * The point of the helper. A tunnel config built by listing fields by hand
   * carried none of these, so a host set to go through a network had its
   * tunnel leave by the server's own route.
   */
  it("says direct for a host that is direct", async () => {
    const fields = hostNetworkFields({ id: 1 });
    expect(fields.vpnProfileId).toBeNull();
    expect(fields.useSocks5).toBe(false);
    await expect(resolveHostGateway(fields, never)).resolves.toBeNull();
  });

  it("round-trips through the resolver", async () => {
    const fields = hostNetworkFields({ vpnProfileId: 1, userId: "user-1" });
    await expect(
      resolveHostGateway(fields, async () => profile()),
    ).resolves.toMatchObject({ useSocks5: true, socks5Host: "vpn-x" });
  });
});

describe("a profile belongs to someone", () => {
  it("refuses to resolve one when the owner is unknown", async () => {
    await expect(
      resolveHostGateway({ vpnProfileId: 1, userId: null }, async () =>
        profile(),
      ),
    ).rejects.toThrow(/owner is unknown/i);
  });

  it("asks for the profile under the host's owner", async () => {
    const asked: Array<[number, string]> = [];
    await resolveHostGateway(
      { vpnProfileId: 9, userId: "owner-7" },
      async (id, userId) => {
        asked.push([id, userId]);
        return profile();
      },
    );
    expect(asked).toEqual([[9, "owner-7"]]);
  });
});

describe("a managed network's address", () => {
  it("is the manager's, on a port derived from the id", async () => {
    process.env.NET_MANAGER_TOKEN = "s";
    process.env.NET_MANAGER_URL = "netmgr:3392";
    const config = await resolveHostGateway(
      { vpnProfileId: 12, userId: "user-1" },
      async () => profile({ id: 12, kind: "managed" }),
    );
    expect(config).toMatchObject({
      useSocks5: true,
      socks5Host: "netmgr",
      socks5Port: 20012,
    });
    delete process.env.NET_MANAGER_TOKEN;
    delete process.env.NET_MANAGER_URL;
  });

  it("is not the stored one, which an edited row could have moved", async () => {
    process.env.NET_MANAGER_TOKEN = "s";
    process.env.NET_MANAGER_URL = "netmgr:3392";
    const config = await resolveHostGateway(
      { vpnProfileId: 12, userId: "user-1" },
      async () =>
        profile({
          id: 12,
          kind: "managed",
          gatewayHost: "somewhere-else",
          gatewayPort: 9999,
        }),
    );
    expect(config?.socks5Host).not.toBe("somewhere-else");
    expect(config?.socks5Port).not.toBe(9999);
    delete process.env.NET_MANAGER_TOKEN;
    delete process.env.NET_MANAGER_URL;
  });

  it("refuses when no manager is configured, rather than connecting directly", async () => {
    delete process.env.NET_MANAGER_TOKEN;
    await expect(
      resolveHostGateway({ vpnProfileId: 12, userId: "user-1" }, async () =>
        profile({ id: 12, kind: "managed" }),
      ),
    ).rejects.toThrow(/no VPN manager is configured/i);
  });
});

describe("a network that is switched off", () => {
  it("says so, rather than failing as an empty address", async () => {
    process.env.NET_MANAGER_TOKEN = "s";
    await expect(
      resolveHostGateway({ vpnProfileId: 4, userId: "user-1" }, async () =>
        profile({ id: 4, kind: "managed", enabled: false }),
      ),
    ).rejects.toThrow(/switched off/i);
    delete process.env.NET_MANAGER_TOKEN;
  });

  it("still resolves one that is on", async () => {
    process.env.NET_MANAGER_TOKEN = "s";
    process.env.NET_MANAGER_URL = "netmgr:3392";
    await expect(
      resolveHostGateway({ vpnProfileId: 4, userId: "user-1" }, async () =>
        profile({ id: 4, kind: "managed", enabled: true }),
      ),
    ).resolves.toMatchObject({ socks5Port: 20004 });
    delete process.env.NET_MANAGER_TOKEN;
    delete process.env.NET_MANAGER_URL;
  });
});
