/**
 * "Can this doorway be dialled right now?"
 *
 * The connect path never asks: it is about to raise whatever it needs. The
 * status dot does, because dialling a doorway is what raises a tunnel and the
 * dot asks for every host every thirty seconds.
 *
 * A provider written before this existed answers nothing, and the answer has
 * to be yes -- defaulting to no would quietly stop probing every host behind
 * every gateway.
 */

import { describe, expect, it, vi } from "vitest";

const getServiceImplementation = vi.fn();
vi.mock("../../../plugins/service-registry.js", () => ({
  getServiceImplementation: (...args: unknown[]) =>
    getServiceImplementation(...args),
}));

const { resolveHostGateway } =
  await import("../../../hosts/connect/host-gateway.js");

const host = { id: 1, userId: "owner" } as never;

describe("a gateway's isUp", () => {
  it("is the provider's answer", async () => {
    getServiceImplementation.mockReturnValue({
      forHost: async () => ({ useSocks5: true, socks5Host: "netmgr" }),
      isUp: async () => false,
    });

    const gateway = await resolveHostGateway(host);
    await expect(gateway?.isUp()).resolves.toBe(false);
  });

  it("is yes when the provider does not answer", async () => {
    getServiceImplementation.mockReturnValue({
      forHost: async () => ({ useSocks5: true, socks5Host: "netmgr" }),
    });

    const gateway = await resolveHostGateway(host);
    await expect(gateway?.isUp()).resolves.toBe(true);
  });

  it("is yes for the host's own proxy, which nothing of ours raises", async () => {
    getServiceImplementation.mockReturnValue(undefined);

    const gateway = await resolveHostGateway({
      id: 1,
      userId: "owner",
      useSocks5: true,
      socks5Host: "proxy.example",
      socks5Port: 1080,
    } as never);
    await expect(gateway?.isUp()).resolves.toBe(true);
  });
});
