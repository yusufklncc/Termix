/**
 * Fork: ctx.hosts.probeTargets and ctx.ssh.probe for a host behind a VPN.
 * The status plugin dials a target's address unless it has jump hosts, so
 * such a host is listed with one, and ctx.ssh.probe goes through the VPN.
 * See probe/gateway-probe.ts.
 */

import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const grants = new Map<string, string[]>();
const state = vi.hoisted(() => ({
  owned: [] as Array<Record<string, unknown>>,
  shared: [] as Array<Record<string, unknown>>,
  sharedIds: [] as number[],
  allowed: new Set<number>(),
}));

vi.mock("../../database/repositories/factory.js", () => ({
  createCurrentPluginPermissionGrantRepository: () => ({
    listByPlugin: async (pluginId: string) =>
      (grants.get(pluginId) ?? []).map((capability) => ({
        pluginId,
        capability,
      })),
  }),
  createCurrentHostResolutionRepository: () => ({
    listStatusTargets: async (filter: {
      userId?: string;
      hostIds?: number[];
    }) => {
      const rows = filter.userId ? state.owned : state.shared;
      return rows.filter(
        (row) => !filter.hostIds || filter.hostIds.includes(row.id as number),
      );
    },
  }),
  createCurrentRoleRepository: () => ({ listUserRoleIds: async () => [] }),
  createCurrentRbacAccessRepository: () => ({
    listVisibleHostAccessEntries: async () =>
      state.sharedIds.map((hostId) => ({ hostId })),
  }),
}));
vi.mock("../../utils/permission-manager.js", () => ({
  PermissionManager: {
    getInstance: () => ({
      filterAccessibleHostIds: async (_user: string, ids: number[]) =>
        new Set(ids.filter((id) => state.allowed.has(id))),
      canAccessHost: async (_user: string, id: number) => ({
        hasAccess: state.allowed.has(id),
      }),
    }),
  },
}));
const dns = vi.hoisted(() => ({
  lookup: vi.fn(),
}));
vi.mock("node:dns/promises", () => ({ lookup: dns.lookup }));
vi.mock("../../utils/audit-logger.js", () => ({ logAudit: async () => {} }));
const vpn = vi.hoisted(() => ({
  hostIds: new Set<number>(),
  ping: vi.fn(async () => true),
}));
vi.mock("../../hosts/connect/host-gateway.js", () => ({
  resolveHostGateway: async (host: { id: number }) =>
    vpn.hostIds.has(host.id)
      ? {
          config: { useSocks5: true, socks5Host: "netmgr", socks5Port: 20001 },
          isUp: async () => true,
          resolveName: async () => null,
          describeFailure: async () => "",
        }
      : null,
}));
vi.mock("../../utils/socks5-helper.js", () => ({
  createSocks5Connection: async (...args: unknown[]) => {
    await vpn.ping(...(args as []));
    return { destroy: () => {} };
  },
}));

import { createPluginContext, createPluginHandle } from "../../plugins/ctx.js";
import { invalidatePluginPermissionCache } from "../../plugins/permissions.js";
import { runAsActor } from "../../plugins/actor.js";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";

function contextFor(capabilities: string[]) {
  const manifest = {
    id: "demo",
    name: "demo",
    version: "1.0.0",
    description: "",
    author: { name: "test" },
    license: "MIT",
    category: "Productivity",
    engine: { termix: ">=26.10.3", api: "1" },
    capabilities,
  } as PluginManifest;
  return createPluginContext(
    manifest,
    createPluginHandle("demo", { activate: () => {} }),
  );
}

const row = (id: number, userId: string) => ({
  id,
  userId,
  ip: "127.0.0.1",
  port: 22,
  connectionType: "ssh",
  jumpHosts: null,
  statusCheckEnabled: true,
  statusCheckInterval: null,
});

let server: net.Server;

beforeEach(async () => {
  grants.clear();
  dns.lookup.mockReset();
  invalidatePluginPermissionCache();
  state.owned = [row(1, "alice")];
  state.shared = [row(2, "bob"), row(3, "bob")];
  state.sharedIds = [2, 3];
  state.allowed = new Set([2]);
  server = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

afterEach(() => {
  server.close();
});

describe("a host behind a VPN", () => {
  it("is listed with a hop, so the status plugin asks core about it", async () => {
    vpn.hostIds = new Set([1]);
    grants.set("demo", ["hosts:read"]);
    const ctx = contextFor(["hosts:read"]);
    const targets = await runAsActor("alice", "request", () =>
      ctx.hosts.probeTargets(),
    );
    expect(targets.find((t) => t.id === 1)?.jumpHosts).toEqual([{ hostId: 1 }]);
    expect(targets.find((t) => t.id === 2)?.jumpHosts).toEqual([]);
  });

  it("is probed through the VPN, not at its own address", async () => {
    vpn.hostIds = new Set([2]);
    vpn.ping.mockClear();
    grants.set("demo", ["ssh:connect"]);
    const ctx = contextFor(["ssh:connect"]);
    // Port 1 on loopback answers nothing: a direct dial would say false.
    expect(
      await runAsActor("alice", "request", () => ctx.ssh.probe(2, { port: 1 })),
    ).toBe(true);
    expect(vpn.ping).toHaveBeenCalledWith(
      "127.0.0.1",
      1,
      expect.objectContaining({ socks5Port: 20001 }),
    );
  });
});
