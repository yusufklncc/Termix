/**
 * The status dot for a host that is not reached from here.
 *
 * Until now every host was dialled at its own address from wherever Termix
 * runs. For a host behind a VPN that is wrong twice over: the dot said
 * offline for a machine that was up, and the packets left by the server's own
 * route -- an address that exists only inside a customer's network, dialled
 * from a home connection.
 *
 * The fix is not simply "probe through the VPN". Connecting to a managed
 * doorway is what raises the tunnel, and the dot asks every thirty seconds
 * for every host, so a probe that dialled regardless would hold every
 * customer's network open for as long as somebody leaves the app open and the
 * manager's idle timer would never fire. A route that is not up means the
 * host was not asked, and the entry says so.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../database/repositories/factory.js", () => ({
  createCurrentHostResolutionRepository: vi.fn(),
  getCurrentSettingValue: vi.fn(() => null),
}));
vi.mock("../../../utils/logger.js", () => ({
  sshLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  pluginLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const {
  HostStatusService,
  GATEWAY_DOWN_REASON,
  GATEWAY_UNREADABLE_REASON,
  toStatusTarget,
} = await import("../../../hosts/status/host-status-service.js");

type Target = ReturnType<typeof toStatusTarget>;

function target(id: number, extra: Partial<Target> = {}): Target {
  return {
    id,
    userId: "owner",
    ip: `10.9.0.${id}`,
    port: 22,
    connectionType: "ssh",
    jumpHosts: [],
    statusCheckEnabled: true,
    statusCheckInterval: null,
    ...extra,
  };
}

function setup(
  through: { reachable: boolean | null } | null,
  targets: Target[] = [target(1)],
) {
  const ping = vi.fn(async () => true);
  const pingThroughJumpHosts = vi.fn(async () => true);
  const probeThroughGateway = vi.fn(async () => through);
  const service = new HostStatusService({
    loadTargets: async (filter) =>
      targets.filter((t) => !filter.hostIds || filter.hostIds.includes(t.id)),
    ping,
    pingThroughJumpHosts,
    probeThroughGateway,
    globalInterval: () => 60,
    emit: () => {},
    retryDelayMs: 0,
  });
  return { service, ping, pingThroughJumpHosts, probeThroughGateway };
}

let active: InstanceType<typeof HostStatusService> | null = null;

afterEach(() => {
  active?.stop();
  active = null;
  vi.clearAllMocks();
});

describe("a host that leaves through a gateway", () => {
  it("is asked through it, not at its own address", async () => {
    const { service, ping, probeThroughGateway } = setup({ reachable: true });
    active = service;

    await expect(service.check(1)).resolves.toMatchObject({
      status: "online",
    });
    expect(probeThroughGateway).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1 }),
      22,
    );
    // The leak this was written for: 10.9.0.1 is reachable from inside that
    // network and from nowhere else.
    expect(ping).not.toHaveBeenCalled();
  });

  it("is offline when the gateway says the port does not answer", async () => {
    const { service, ping } = setup({ reachable: false });
    active = service;

    await expect(service.check(1)).resolves.toMatchObject({
      status: "offline",
    });
    expect(ping).not.toHaveBeenCalled();
  });
});

describe("a gateway that is not up", () => {
  it("leaves the host unasked and says why", async () => {
    const { service, ping } = setup({ reachable: null });
    active = service;

    const entry = await service.check(1);
    expect(entry).toMatchObject({
      status: "offline",
      reason: GATEWAY_DOWN_REASON,
    });
    expect(ping).not.toHaveBeenCalled();
  });

  it("does not try a second time", async () => {
    // The retry is there for one lost packet. Nothing was sent.
    const { service, probeThroughGateway } = setup({ reachable: null });
    active = service;

    await service.check(1);
    expect(probeThroughGateway).toHaveBeenCalledTimes(1);
  });

  it("drops the reason once the host is reached again", async () => {
    // A working login proves it is up, whatever the dot last said.
    const { service } = setup({ reachable: null });
    active = service;

    await service.check(1);
    service.reportLogin(1, { ok: true });

    const entry = service.get(1);
    expect(entry).toMatchObject({ status: "online" });
    expect(entry?.reason).toBeUndefined();
  });
});

describe("the hosts this does not touch", () => {
  it("probes a host with no gateway directly, as before", async () => {
    const { service, ping } = setup(null);
    active = service;

    await expect(service.check(1)).resolves.toMatchObject({
      status: "online",
    });
    expect(ping).toHaveBeenCalledWith("10.9.0.1", 22);
  });

  it("prefers a jump host chain, which reaches the host from inside", async () => {
    const { service, pingThroughJumpHosts, probeThroughGateway } = setup(
      { reachable: null },
      [target(1, { jumpHosts: [{ hostId: 2 }] })],
    );
    active = service;

    await expect(service.check(1)).resolves.toMatchObject({
      status: "online",
    });
    expect(pingThroughJumpHosts).toHaveBeenCalled();
    expect(probeThroughGateway).not.toHaveBeenCalled();
  });
});

describe("every reason the backend can send", () => {
  it("has English to show for it", async () => {
    /*
     * The reason travels to the tooltip as a key, and a key with no string
     * behind it renders as "hosts.status.gatewayDown" in the interface.
     * Nothing else would catch that: the backend is happy either way.
     */
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const en = JSON.parse(
      readFileSync(
        path.join(import.meta.dirname, "../../../../ui/locales/en.json"),
        "utf8",
      ),
    );

    for (const reason of [GATEWAY_DOWN_REASON, GATEWAY_UNREADABLE_REASON]) {
      const text = reason
        .split(".")
        .reduce<unknown>(
          (node, key) => (node as Record<string, unknown>)?.[key],
          en,
        );
      expect(typeof text, reason).toBe("string");
    }
  });
});
