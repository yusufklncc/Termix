/**
 * The status dot for a host that has a proxy of its own.
 *
 * The VPN plugin's hosts stopped being dialled from here, but core's own
 * socks5 fields are the same leak: a host set to leave through a proxy was
 * still probed at its own address, from wherever Termix runs.
 *
 * Reading those fields costs more than asking a plugin, because the password
 * among them is encrypted under the owner's key -- so the flag is carried on
 * the cheap status row and only the hosts that have it pay for the rest. When
 * nothing can decrypt the row, the host is left unasked rather than dialled
 * directly: that is the one outcome the proxy was set to prevent.
 *
 * This exercises the wiring the service ships with, not an injected double.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const findHostByIdForUser = vi.fn();
const listStatusTargets = vi.fn();
vi.mock("../../../database/repositories/factory.js", () => ({
  createCurrentHostResolutionRepository: () => ({
    findHostByIdForUser,
    listStatusTargets,
  }),
  getCurrentSettingValue: vi.fn(() => null),
}));
vi.mock("../../../utils/logger.js", () => ({
  sshLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  pluginLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// No plugin answers, so core reads the host's own fields.
vi.mock("../../../plugins/service-registry.js", () => ({
  getServiceImplementation: () => undefined,
}));

const tcpPing = vi.fn(async () => true);
const tcpPingThroughProxy = vi.fn(async () => true);
vi.mock("../../../hosts/status/tcp-ping.js", () => ({
  tcpPing: (...args: unknown[]) => tcpPing(...(args as [])),
  tcpPingThroughProxy: (...args: unknown[]) =>
    tcpPingThroughProxy(...(args as [])),
}));

const { HostStatusService, GATEWAY_UNREADABLE_REASON } =
  await import("../../../hosts/status/host-status-service.js");

function row(extra: Record<string, unknown> = {}) {
  return {
    id: 1,
    userId: "owner",
    ip: "10.9.0.1",
    port: 22,
    connectionType: "ssh",
    jumpHosts: null,
    statusCheckEnabled: true,
    statusCheckInterval: null,
    useSocks5: false,
    ...extra,
  };
}

function service(target: Record<string, unknown>) {
  listStatusTargets.mockResolvedValue([target]);
  // The deps the service ships with, including the gateway probe.
  return new HostStatusService();
}

let active: InstanceType<typeof HostStatusService> | null = null;

afterEach(() => {
  active?.stop();
  active = null;
  vi.clearAllMocks();
  tcpPing.mockResolvedValue(true);
  tcpPingThroughProxy.mockResolvedValue(true);
});

describe("a host with its own proxy", () => {
  it("is probed through it, with the decrypted password", async () => {
    findHostByIdForUser.mockResolvedValue({
      id: 1,
      userId: "owner",
      useSocks5: true,
      socks5Host: "proxy.example",
      socks5Port: 1080,
      socks5Username: "user",
      // What the row holds once it has been through DataCrypto.
      socks5Password: "secret",
      socks5ProxyChain: null,
    });
    const instance = service(row({ useSocks5: true }));
    active = instance;

    await expect(instance.check(1)).resolves.toMatchObject({
      status: "online",
    });
    expect(tcpPingThroughProxy).toHaveBeenCalledWith(
      expect.objectContaining({
        socks5Host: "proxy.example",
        socks5Port: 1080,
        socks5Username: "user",
        socks5Password: "secret",
      }),
      "10.9.0.1",
      22,
      5000,
    );
    expect(tcpPing).not.toHaveBeenCalled();
  });

  it("goes through a chain the column keeps as JSON text", async () => {
    // A host with no single proxy address, only a chain. Left unparsed this
    // resolves to no proxy at all, and the probe goes out directly.
    findHostByIdForUser.mockResolvedValue({
      id: 1,
      userId: "owner",
      useSocks5: true,
      socks5Host: null,
      socks5ProxyChain: '[{"type":"socks5","host":"hop.example","port":1080}]',
    });
    const instance = service(row({ useSocks5: true }));
    active = instance;

    await instance.check(1);
    expect(tcpPingThroughProxy).toHaveBeenCalledWith(
      expect.objectContaining({
        socks5ProxyChain: [{ type: "socks5", host: "hop.example", port: 1080 }],
      }),
      "10.9.0.1",
      22,
      5000,
    );
    expect(tcpPing).not.toHaveBeenCalled();
  });

  it("is reported offline when the proxy cannot place the connection", async () => {
    findHostByIdForUser.mockResolvedValue({
      id: 1,
      userId: "owner",
      useSocks5: true,
      socks5Host: "proxy.example",
      socks5Port: 1080,
    });
    tcpPingThroughProxy.mockResolvedValue(false);
    const instance = service(row({ useSocks5: true }));
    active = instance;

    const entry = await instance.check(1);
    expect(entry).toMatchObject({ status: "offline" });
    expect(entry?.reason).toBeUndefined();
    expect(tcpPing).not.toHaveBeenCalled();
  });

  it("is left unasked when its row cannot be decrypted", async () => {
    // The owner is not signed in, so there is no key for the password.
    findHostByIdForUser.mockResolvedValue(null);
    const instance = service(row({ useSocks5: true }));
    active = instance;

    await expect(instance.check(1)).resolves.toMatchObject({
      status: "offline",
      reason: GATEWAY_UNREADABLE_REASON,
    });
    expect(tcpPing).not.toHaveBeenCalled();
    expect(tcpPingThroughProxy).not.toHaveBeenCalled();
  });
});

describe("a host without one", () => {
  it("is dialled directly, and its row is never read", async () => {
    const instance = service(row());
    active = instance;

    await expect(instance.check(1)).resolves.toMatchObject({
      status: "online",
    });
    expect(tcpPing).toHaveBeenCalledWith("10.9.0.1", 22, 5000);
    // Decrypting every row on every poll is what the flag avoids.
    expect(findHostByIdForUser).not.toHaveBeenCalled();
  });
});
