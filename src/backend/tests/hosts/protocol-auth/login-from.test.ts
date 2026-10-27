/**
 * A protocol that borrows another's login.
 *
 * Direct RDP is a second renderer for the same RDP host, but it was declared
 * as a protocol of its own and so looked only for a login saved under
 * "rdp-direct" -- which nothing in the host editor ever writes. Every
 * connection fell back to the host's SSH login: the SSH user rather than the
 * Windows one, no domain, and no password at all whenever SSH signs in with a
 * key. Reported as "Direct RDP does not know which credential to use", while
 * the RDP login sat saved under "rdp" the whole time.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const logins = vi.hoisted(() => new Map<string, Record<string, unknown>>());

vi.mock("../../../database/db/index.js", () => ({
  getDb: () => null,
  getSqlite: () => null,
}));
vi.mock("../../../utils/data-crypto.js", () => ({
  DataCrypto: { getUserDataKey: () => Buffer.alloc(32) },
}));
vi.mock("../../../database/repositories/factory.js", () => ({
  createCurrentHostProtocolAuthRepository: () => ({
    find: async (_hostId: number, protocol: string) =>
      logins.get(protocol) ?? null,
  }),
}));
vi.mock("../../../hosts/usable-credential.js", () => ({
  findUsableCredential: async () => null,
}));
vi.mock("../../../hosts/defaults/service.js", () => ({
  resolveForEditor: async () => ({}),
}));

const { resolveOwnerProtocolLogin } =
  await import("../../../hosts/protocol-auth/protocol-auth.js");

const DIRECT = {
  id: "rdp-direct",
  pluginId: "rdp-direct",
  pluginName: "Direct RDP",
  credentialFields: [{ key: "domain" }],
  hostLoginFallback: ["username", "password"],
  loginFrom: "rdp",
};

/** A Windows host that SSH reaches with a key, as the reported one did. */
const host = { id: 4, userId: "owner", username: "ssh-user", authType: "key" };

const RDP_LOGIN = {
  authType: "direct",
  username: "yusuf",
  password: "windows-pass",
  fields: { domain: "LENOVO" },
};

beforeEach(() => logins.clear());

describe("a protocol with loginFrom", () => {
  it("uses the RDP login when it has none of its own", async () => {
    logins.set("rdp", RDP_LOGIN);
    const login = await resolveOwnerProtocolLogin(host, DIRECT as never);
    expect(login).toMatchObject({
      username: "yusuf",
      password: "windows-pass",
      fields: { domain: "LENOVO" },
    });
  });

  it("does not hand over the SSH user, or an empty password", async () => {
    // What it did before, for the record.
    logins.set("rdp", RDP_LOGIN);
    const login = await resolveOwnerProtocolLogin(host, DIRECT as never);
    expect(login.username).not.toBe("ssh-user");
    expect(login.password).not.toBe("");
  });

  it("still prefers a login saved for itself", async () => {
    logins.set("rdp", RDP_LOGIN);
    logins.set("rdp-direct", {
      authType: "direct",
      username: "other",
      password: "other-pass",
    });
    const login = await resolveOwnerProtocolLogin(host, DIRECT as never);
    expect(login).toMatchObject({ username: "other", password: "other-pass" });
  });

  it("falls back to the host's own login when neither has one", async () => {
    const passwordHost = { ...host, authType: "password", password: "ssh-pw" };
    const login = await resolveOwnerProtocolLogin(
      passwordHost,
      DIRECT as never,
    );
    expect(login).toMatchObject({ username: "ssh-user", password: "ssh-pw" });
  });
});

describe("a protocol without it", () => {
  it("reads only its own login, as before", async () => {
    logins.set("rdp", RDP_LOGIN);
    const { loginFrom: _, ...plain } = DIRECT;
    const login = await resolveOwnerProtocolLogin(host, plain as never);
    // Untouched behaviour: the SSH user, and no password for a key host.
    expect(login).toMatchObject({ username: "ssh-user", password: "" });
  });
});
