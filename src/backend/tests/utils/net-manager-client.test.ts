import crypto from "crypto";
import { describe, expect, it } from "vitest";
import {
  managedDoorPort,
  resolveNetManagerOptions,
  sealCredentials,
} from "../../utils/net-manager-client.js";

/**
 * The manager unseals with its own copy of this derivation (docker/net-manager
 * /manager.js). Nothing links the two but agreement, so this is where that
 * agreement is written down: change one side and this fails rather than a
 * network quietly refusing to come up.
 */
function unsealTheWayTheManagerDoes(
  token: string,
  sealed: { iv: string; tag: string; data: string },
) {
  const key = Buffer.from(
    crypto.hkdfSync(
      "sha256",
      Buffer.from(token, "utf8"),
      Buffer.from("termix-net-manager", "utf8"),
      Buffer.from("credentials", "utf8"),
      32,
    ),
  );
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(sealed.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(sealed.data, "base64")),
      decipher.final(),
    ]).toString("utf8"),
  );
}

describe("sealCredentials", () => {
  it("is opened by the derivation the manager uses", () => {
    const sealed = sealCredentials("a-long-secret", {
      username: "u",
      password: "p",
    });
    expect(unsealTheWayTheManagerDoes("a-long-secret", sealed)).toEqual({
      username: "u",
      password: "p",
    });
  });

  it("does not carry the secret in the clear", () => {
    const sealed = sealCredentials("a-long-secret", { password: "hunter2" });
    expect(JSON.stringify(sealed)).not.toContain("hunter2");
  });

  it("is not opened under a different secret", () => {
    const sealed = sealCredentials("a-long-secret", { password: "hunter2" });
    expect(() =>
      unsealTheWayTheManagerDoes("another-secret", sealed),
    ).toThrow();
  });

  it("uses a fresh nonce each time", () => {
    const first = sealCredentials("s", { password: "p" });
    const second = sealCredentials("s", { password: "p" });
    expect(first.iv).not.toEqual(second.iv);
    expect(first.data).not.toEqual(second.data);
  });
});

describe("managedDoorPort", () => {
  it("is computed from the id, so a restart need not be announced", () => {
    expect(managedDoorPort(7)).toBe(20007);
  });
});

describe("resolveNetManagerOptions", () => {
  it("is absent without a secret, so managed networks fail rather than guess", () => {
    const saved = process.env.NET_MANAGER_TOKEN;
    delete process.env.NET_MANAGER_TOKEN;
    expect(resolveNetManagerOptions()).toBeNull();
    if (saved !== undefined) process.env.NET_MANAGER_TOKEN = saved;
  });

  it("takes a host:port, and falls back to the sidecar's own name", () => {
    process.env.NET_MANAGER_TOKEN = "s";
    process.env.NET_MANAGER_URL = "netmgr.internal:4000";
    expect(resolveNetManagerOptions()).toMatchObject({
      host: "netmgr.internal",
      port: 4000,
    });
    delete process.env.NET_MANAGER_URL;
    expect(resolveNetManagerOptions()).toMatchObject({
      host: "termix-netmgr",
      port: 3392,
    });
    delete process.env.NET_MANAGER_TOKEN;
  });
});
