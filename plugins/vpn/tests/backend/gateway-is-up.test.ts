/**
 * Whether a host's doorway can be dialled without raising its tunnel.
 *
 * Only the status dot asks. Connecting to a managed doorway is what raises
 * the tunnel, and the dot asks for every host every thirty seconds -- so
 * answering yes while the tunnel is down would hold every customer's network
 * open for as long as somebody leaves the app open, and the manager's idle
 * timer, which drops a tunnel five minutes after its last connection, would
 * never fire.
 *
 * A gateway somebody else runs is a different matter: nothing of ours raises
 * it, so it is always there to be dialled.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const listManagedNetworks = vi.fn();
vi.mock("../../src/backend/net-manager-client", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/backend/net-manager-client")
  >()),
  listManagedNetworks: () => listManagedNetworks(),
}));

const { createGatewayService } = await import("../../src/backend/gateway");

type Ctx = Parameters<typeof createGatewayService>[0];
type Repo = Parameters<typeof createGatewayService>[1];

const profile = (over: Record<string, unknown> = {}) => ({
  id: 7,
  userId: "owner",
  name: "Acme",
  kind: "managed",
  enabled: true,
  ...over,
});

function service(found: Record<string, unknown> | null) {
  const ctx = {
    settings: {
      getAll: vi.fn().mockResolvedValue({ profileId: 7, profileName: "Acme" }),
    },
  } as unknown as Ctx;
  return createGatewayService(ctx, {
    findById: vi.fn().mockResolvedValue(found),
    findByName: vi.fn().mockResolvedValue(found),
  } as unknown as Repo);
}

const host = { id: 1, userId: "owner" };

let clock = 1_000_000;

beforeEach(() => {
  listManagedNetworks.mockReset();
  // The answer is cached for a moment, so each case starts well after the
  // last one -- forwards, or a stale entry still counts as fresh.
  clock += 60_000;
  vi.spyOn(Date, "now").mockReturnValue(clock);
});

describe("isUp, for a network Termix raises itself", () => {
  it("is yes while the tunnel is up", async () => {
    listManagedNetworks.mockResolvedValue([
      { id: 7, state: "up", error: null, port: 20007 },
    ]);
    await expect(service(profile()).isUp(host)).resolves.toBe(true);
  });

  it("is no while it is down", async () => {
    listManagedNetworks.mockResolvedValue([
      { id: 7, state: "down", error: null, port: 20007 },
    ]);
    await expect(service(profile()).isUp(host)).resolves.toBe(false);
  });

  it("is no while it is still connecting", async () => {
    // Dialling now would time out and report a host that is up as offline.
    listManagedNetworks.mockResolvedValue([
      { id: 7, state: "connecting", error: null, port: 20007 },
    ]);
    await expect(service(profile()).isUp(host)).resolves.toBe(false);
  });

  it("is no when another network is the one that is up", async () => {
    listManagedNetworks.mockResolvedValue([
      { id: 8, state: "up", error: null, port: 20008 },
    ]);
    await expect(service(profile()).isUp(host)).resolves.toBe(false);
  });

  it("is no when the manager does not answer at all", async () => {
    listManagedNetworks.mockResolvedValue(null);
    await expect(service(profile()).isUp(host)).resolves.toBe(false);
  });
});

describe("isUp, for everything else", () => {
  it("is yes for a gateway somebody else runs", async () => {
    await expect(
      service(profile({ kind: "declared" })).isUp(host),
    ).resolves.toBe(true);
    expect(listManagedNetworks).not.toHaveBeenCalled();
  });

  it("is yes for a host this plugin has nothing to say about", async () => {
    await expect(service(null).isUp(host)).resolves.toBe(true);
  });
});

describe("the manager is asked once for a burst", () => {
  it("answers a whole poll from one round trip", async () => {
    listManagedNetworks.mockResolvedValue([
      { id: 7, state: "up", error: null, port: 20007 },
    ]);
    const gateway = service(profile());
    await Promise.all([
      gateway.isUp(host),
      gateway.isUp(host),
      gateway.isUp(host),
    ]);
    expect(listManagedNetworks).toHaveBeenCalledTimes(1);
  });
});
