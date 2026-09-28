import { describe, expect, it, vi } from "vitest";
import {
  isRetriableDnsError,
  resolveHostForSshConnect,
  resolveSshConnectConfigHost,
  shouldResolveBeforeSshConnect,
} from "../../hosts/ssh-dns.js";

describe("SSH DNS resolution", () => {
  it("retries transient EAI_AGAIN errors before returning an address", async () => {
    const lookup = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("try again"), { code: "EAI_AGAIN" }),
      )
      .mockResolvedValueOnce({ address: "10.0.0.5", family: 4 });
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(
      resolveHostForSshConnect("alp", lookup, [10], wait),
    ).resolves.toEqual({
      host: "10.0.0.5",
      resolvedAddress: "10.0.0.5",
      attempts: 2,
    });
    expect(wait).toHaveBeenCalledWith(10);
  });

  it("does not retry permanent DNS failures", async () => {
    const error = Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    const lookup = vi.fn().mockRejectedValue(error);
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(
      resolveHostForSshConnect("missing", lookup, [10], wait),
    ).rejects.toBe(error);
    expect(wait).not.toHaveBeenCalled();
  });

  it("skips DNS lookup for literal IP addresses", async () => {
    const lookup = vi.fn();

    await expect(
      resolveHostForSshConnect("192.0.2.1", lookup),
    ).resolves.toEqual({
      host: "192.0.2.1",
      attempts: 0,
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("detects retryable DNS errors by code or message", () => {
    expect(isRetriableDnsError({ code: "EAI_AGAIN" })).toBe(true);
    expect(isRetriableDnsError(new Error("getaddrinfo EAI_AGAIN alp"))).toBe(
      true,
    );
    expect(isRetriableDnsError({ code: "ENOTFOUND" })).toBe(false);
  });

  it("only pre-resolves hostnames", () => {
    expect(shouldResolveBeforeSshConnect("alp")).toBe(true);
    expect(shouldResolveBeforeSshConnect("127.0.0.1")).toBe(false);
    expect(shouldResolveBeforeSshConnect("[2001:db8::1]")).toBe(false);
  });

  it("updates SSH connect config hosts in place", async () => {
    const lookup = vi
      .fn()
      .mockResolvedValue({ address: "10.0.0.6", family: 4 });
    const config = { host: "alp", port: 22 };

    await expect(resolveSshConnectConfigHost(config, lookup)).resolves.toEqual({
      host: "10.0.0.6",
      port: 22,
      originalHost: "alp",
      resolvedHost: "10.0.0.6",
    });
  });
});

/**
 * A name that only exists on the other side of a tunnel.
 *
 * This is what a mesh host looks like: the address is real inside the VPN and
 * nowhere else, so looking it up here fails before the tunnel that would have
 * answered is even built.
 */
describe("a config that already goes through something else", () => {
  it("leaves the address alone when a socket is attached", async () => {
    const lookup = vi.fn();
    const config = {
      host: "kayizer-vds.netbird.selfhosted",
      sock: {} as unknown,
    };

    await expect(resolveSshConnectConfigHost(config, lookup)).resolves.toBe(
      config,
    );
    expect(config.host).toBe("kayizer-vds.netbird.selfhosted");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("still resolves one that does not", async () => {
    const lookup = vi
      .fn()
      .mockResolvedValue({ address: "10.0.0.5", family: 4 });
    const config = { host: "alp" };

    await resolveSshConnectConfigHost(config, lookup);
    expect(config.host).toBe("10.0.0.5");
  });
});
