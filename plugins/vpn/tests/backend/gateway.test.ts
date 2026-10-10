import { describe, expect, it } from "vitest";
import { profileToConfig } from "../../src/backend/gateway";
import type { VpnProfileRecord } from "../../src/backend/repository";

const profile = (over: Partial<VpnProfileRecord> = {}): VpnProfileRecord =>
  ({
    id: 4,
    userId: "owner",
    name: "Acme",
    kind: "managed",
    gatewayType: "socks5",
    gatewayHost: "",
    gatewayPort: 0,
    enabled: true,
    ...over,
  }) as VpnProfileRecord;

/**
 * Where a profile's traffic leaves, and when it must not leave at all.
 *
 * Each refusal here was a way for a session to end up on the server's own
 * route while its host was marked "reach this through somewhere else", which
 * is the one thing this must never allow.
 */
describe("profileToConfig", () => {
  it("works the managed address out rather than trusting a stored one", () => {
    process.env.NET_MANAGER_TOKEN = "test-secret";
    process.env.NET_MANAGER_URL = "tcp://termix-netmgr:3392";
    const config = profileToConfig(
      profile({ gatewayHost: "stale", gatewayPort: 1 }),
    );

    // A row edited by hand, or written before the manager moved, would
    // otherwise send one customer's traffic to another's doorway.
    expect(config.socks5Host).toBe("termix-netmgr");
    expect(config.socks5Port).not.toBe(1);
    expect(config.managedNetworkId).toBe(4);
  });

  it("refuses a VPN that was switched off", () => {
    // Not the same as a tunnel that is down: that one is raised when a
    // session needs it. Silence here would read as "nothing is listening".
    expect(() => profileToConfig(profile({ enabled: false }))).toThrow(
      /disabled/i,
    );
  });

  it("refuses a managed profile with no manager configured", () => {
    // No secret means no manager to speak to: a managed profile then fails
    // to resolve, which is honest -- nothing is raising it.
    delete process.env.NET_MANAGER_TOKEN;
    delete process.env.NET_MANAGER_URL;
    expect(() => profileToConfig(profile())).toThrow(/no VPN manager/i);
  });

  it("takes a declared profile's address as given", () => {
    delete process.env.NET_MANAGER_TOKEN;
    const config = profileToConfig(
      profile({
        kind: "declared",
        gatewayHost: "proxy.acme.example",
        gatewayPort: 1080,
      }),
    );

    expect(config).toMatchObject({
      socks5Host: "proxy.acme.example",
      socks5Port: 1080,
    });
    // The operator runs that one, so there is no network of ours to ask.
    expect(config.managedNetworkId).toBeUndefined();
  });
});
