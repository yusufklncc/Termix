import { afterEach, describe, expect, it, vi } from "vitest";

const listManaged = vi.hoisted(() => vi.fn());
const updateById = vi.hoisted(() => vi.fn(async () => ({})));
const listManagedNetworks = vi.hoisted(() => vi.fn());
const raiseManagedNetwork = vi.hoisted(() =>
  vi.fn(async () => ({ state: "up" })),
);
const resolveNetManagerOptions = vi.hoisted(() =>
  vi.fn(() => ({ host: "netmgr", port: 3392, token: "s" })),
);

vi.mock("../../database/repositories/factory.js", () => ({
  createCurrentVpnProfileRepository: () => ({ listManaged, updateById }),
}));
vi.mock("../../utils/net-manager-client.js", () => ({
  listManagedNetworks,
  raiseManagedNetwork,
  resolveNetManagerOptions,
}));

import { syncManagedNetworks } from "../../hosts/managed-network-sync.js";

const profile = (over: Record<string, unknown> = {}) => ({
  id: 1,
  userId: "user-1",
  provider: "fortinet",
  serverHost: "vpn.example.com",
  serverPort: 443,
  authUsername: "u",
  authPassword: "p",
  lastState: "up",
  ...over,
});

afterEach(() => vi.clearAllMocks());

describe("putting managed networks back", () => {
  it("raises one the manager no longer has", async () => {
    listManaged.mockResolvedValue([profile()]);
    listManagedNetworks.mockResolvedValue([]);

    await expect(syncManagedNetworks()).resolves.toMatchObject({ raised: 1 });
    expect(raiseManagedNetwork).toHaveBeenCalledOnce();
  });

  it("leaves one the manager already knows about alone", async () => {
    listManaged.mockResolvedValue([profile()]);
    listManagedNetworks.mockResolvedValue([{ id: 1, state: "up" }]);

    await syncManagedNetworks();
    expect(raiseManagedNetwork).not.toHaveBeenCalled();
  });

  /**
   * Down is the resting state now: the doorway listens, and the tunnel comes
   * when something connects. Raising an idle VPN again would dial the gateway
   * for nobody.
   */
  it("leaves an idle one alone, because idle is not a fault", async () => {
    listManaged.mockResolvedValue([profile()]);
    listManagedNetworks.mockResolvedValue([{ id: 1, state: "idle" }]);

    await syncManagedNetworks();
    expect(raiseManagedNetwork).not.toHaveBeenCalled();
  });

  /**
   * The rule this exists for. Retrying a password the gateway refused cannot
   * succeed, and a FortiGate counts the attempts -- which is how a real
   * account was locked, and why waiting for the lockout to lapse never
   * helped: the next attempt arrived before it did.
   */
  it("never retries a credential the gateway refused", async () => {
    listManaged.mockResolvedValue([profile({ lastState: "refused" })]);
    listManagedNetworks.mockResolvedValue([]);

    await expect(syncManagedNetworks()).resolves.toMatchObject({
      raised: 0,
      skipped: 1,
    });
    expect(raiseManagedNetwork).not.toHaveBeenCalled();
  });

  it("leaves one the operator switched off alone", async () => {
    listManaged.mockResolvedValue([
      profile({ enabled: false, lastState: "off" }),
    ]);
    listManagedNetworks.mockResolvedValue([]);

    await expect(syncManagedNetworks()).resolves.toMatchObject({
      raised: 0,
      skipped: 1,
    });
    expect(raiseManagedNetwork).not.toHaveBeenCalled();
  });

  it("does retry one that failed for another reason", async () => {
    listManaged.mockResolvedValue([profile({ lastState: "error" })]);
    listManagedNetworks.mockResolvedValue([]);

    await syncManagedNetworks();
    expect(raiseManagedNetwork).toHaveBeenCalledOnce();
  });

  it("raises nothing when the manager does not answer", async () => {
    listManaged.mockResolvedValue([profile({ lastState: "down" })]);
    listManagedNetworks.mockResolvedValue(null);

    await expect(syncManagedNetworks()).resolves.toMatchObject({ raised: 0 });
    expect(raiseManagedNetwork).not.toHaveBeenCalled();
  });

  it("does nothing at all without a manager configured", async () => {
    resolveNetManagerOptions.mockReturnValueOnce(
      null as unknown as ReturnType<typeof resolveNetManagerOptions>,
    );

    await syncManagedNetworks();
    expect(listManaged).not.toHaveBeenCalled();
  });

  it("records what came back, so the badge stops showing the old answer", async () => {
    listManaged.mockResolvedValue([profile({ lastState: "down" })]);
    listManagedNetworks.mockResolvedValue([]);
    raiseManagedNetwork.mockResolvedValueOnce({
      state: "refused",
      error: "Failed to complete authentication",
    } as never);

    await syncManagedNetworks();
    expect(updateById).toHaveBeenCalledWith(1, "user-1", {
      lastState: "refused",
      lastError: "Failed to complete authentication",
    });
  });
});
