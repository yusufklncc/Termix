/**
 * Which network a host leaves through, when its id and its name disagree.
 *
 * A profile id means "the nth profile of the account that wrote it". Host
 * export carries plugin host settings, so exporting a host behind a VPN and
 * importing it elsewhere would hand that number to a different account,
 * where it points at whatever happens to be nth -- and the host would
 * quietly leave through someone else's network. So the name travels beside
 * the id, and the name is the one that decides.
 */

import { describe, expect, it, vi } from "vitest";
import { createGatewayService } from "../../src/backend/gateway";
import type {
  VpnProfileRecord,
  VpnProfileRepository,
} from "../../src/backend/repository";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";

const profile = (over: Partial<VpnProfileRecord> = {}): VpnProfileRecord =>
  ({
    id: 7,
    userId: "owner",
    name: "Acme",
    kind: "declared",
    gatewayType: "socks5",
    gatewayHost: "gw.example.com",
    gatewayPort: 1080,
    enabled: true,
    ...over,
  }) as VpnProfileRecord;

function service(
  settings: Record<string, unknown>,
  profiles: {
    byId?: VpnProfileRecord | null;
    byName?: VpnProfileRecord | null;
  },
) {
  const findById = vi.fn().mockResolvedValue(profiles.byId ?? null);
  const findByName = vi.fn().mockResolvedValue(profiles.byName ?? null);
  const ctx = {
    settings: { getAll: vi.fn().mockResolvedValue(settings) },
  } as unknown as PluginContext;
  const gateway = createGatewayService(ctx, {
    findById,
    findByName,
  } as unknown as VpnProfileRepository);
  return { gateway, findById, findByName };
}

const host = { id: 1, userId: "owner" };

describe("which profile a host resolves to", () => {
  it("takes the id when the name agrees with it", async () => {
    const { gateway, findByName } = service(
      { profileId: 7, profileName: "Acme" },
      { byId: profile() },
    );
    const config = await gateway.forHost(host);
    expect(config?.socks5Host).toBe("gw.example.com");
    // No reason to look it up twice.
    expect(findByName).not.toHaveBeenCalled();
  });

  it("prefers the name when the id points somewhere else", async () => {
    // What an imported host looks like: id 7 exists here, but it is a
    // different network from the one the host was configured for.
    const { gateway, findByName } = service(
      { profileId: 7, profileName: "Acme" },
      {
        byId: profile({ name: "Someone else's", gatewayHost: "wrong.example" }),
        byName: profile({ id: 22, gatewayHost: "right.example" }),
      },
    );
    const config = await gateway.forHost(host);
    expect(config?.socks5Host).toBe("right.example");
    expect(findByName).toHaveBeenCalledWith("Acme", "owner");
  });

  it("falls back to the name when the id resolves to nothing", async () => {
    const { gateway } = service(
      { profileId: 7, profileName: "Acme" },
      { byId: null, byName: profile({ id: 3 }) },
    );
    await expect(gateway.forHost(host)).resolves.toMatchObject({
      useSocks5: true,
    });
  });

  it("refuses a host whose network does not exist here", async () => {
    // Rather than connecting straight out, which is the route the profile
    // was there to avoid.
    const { gateway } = service(
      { profileId: 7, profileName: "Acme" },
      { byId: null, byName: null },
    );
    await expect(gateway.forHost(host)).rejects.toThrow(/no such VPN here/i);
  });

  it("still refuses a bare id that resolves to nothing", async () => {
    // A host saved before the name was carried.
    const { gateway } = service({ profileId: 7 }, { byId: null });
    await expect(gateway.forHost(host)).rejects.toThrow(/no longer exists/i);
  });

  it("says nothing about a host with no VPN at all", async () => {
    const { gateway } = service({}, {});
    await expect(gateway.forHost(host)).resolves.toBeNull();
  });

  it("works from the name alone", async () => {
    // An import that carried the name and no usable id.
    const { gateway, findById } = service(
      { profileName: "Acme" },
      { byName: profile({ id: 9 }) },
    );
    await expect(gateway.forHost(host)).resolves.toMatchObject({
      useSocks5: true,
    });
    expect(findById).not.toHaveBeenCalled();
  });
});
