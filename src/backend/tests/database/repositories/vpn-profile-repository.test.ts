import { afterEach, describe, expect, it, vi } from "vitest";
import { TestSqliteDatabase } from "./test-support.js";
import { DataCrypto } from "../../../utils/data-crypto.js";
import { VpnProfileRepository } from "../../../database/repositories/vpn-profile-repository.js";

/**
 * A profile's secrets go in encrypted and have to come back out readable.
 *
 * create and updateById used to return the row as stored, while findById
 * returned it decrypted -- so a caller that read authPassword from a freshly
 * saved profile got the ciphertext and handed it to a VPN gateway as the
 * password. Everything else looked right: the gateway was reached, TLS
 * negotiated, the certificate pinned, and only the login failed.
 */
describe("VpnProfileRepository", () => {
  let adapter: TestSqliteDatabase | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (adapter) {
      await adapter.close();
      adapter = null;
    }
  });

  async function createRepository(): Promise<VpnProfileRepository> {
    adapter = new TestSqliteDatabase();
    const context = await adapter.connect();
    await adapter.exec(`
      INSERT INTO users (id, username, password_hash)
      VALUES ('user-1', 'alice', 'hash');
    `);
    return new VpnProfileRepository(context);
  }

  /** Encryption stands in for the real thing; what matters here is which
   * direction each method leaves the record in. */
  function mockCrypto(): void {
    vi.spyOn(DataCrypto, "validateUserAccess").mockReturnValue(
      Buffer.from("user-key"),
    );
    vi.spyOn(DataCrypto, "getUserDataKey").mockReturnValue(
      Buffer.from("user-key"),
    );
    vi.spyOn(DataCrypto, "encryptRecord").mockImplementation(
      (_table, record) =>
        ({
          ...record,
          ...(record.authPassword
            ? { authPassword: `sealed:${record.authPassword}` }
            : {}),
        }) as typeof record,
    );
    vi.spyOn(DataCrypto, "decryptRecord").mockImplementation(
      (_table, record) =>
        ({
          ...record,
          ...(typeof record.authPassword === "string" &&
          record.authPassword.startsWith("sealed:")
            ? { authPassword: record.authPassword.slice("sealed:".length) }
            : {}),
        }) as typeof record,
    );
  }

  const managed = {
    userId: "user-1",
    name: "Acme",
    kind: "managed",
    gatewayHost: "termix-netmgr",
    gatewayPort: 1,
    provider: "fortinet",
    serverHost: "vpn.acme.example",
    authUsername: "someone",
    authPassword: "the-real-password",
  };

  it("hands back a readable password after creating", async () => {
    const repo = await createRepository();
    mockCrypto();

    const created = await repo.create(managed);

    expect(created.authPassword).toBe("the-real-password");
  });

  it("stores it sealed all the same", async () => {
    const repo = await createRepository();
    mockCrypto();

    await repo.create(managed);
    const [row] = await adapter!.query(
      "SELECT auth_password FROM vpn_profiles WHERE id = 1",
    );

    expect(row.auth_password).toBe("sealed:the-real-password");
  });

  it("hands back a readable password after updating", async () => {
    const repo = await createRepository();
    mockCrypto();

    const created = await repo.create(managed);
    const updated = await repo.updateById(created.id, "user-1", {
      authPassword: "a-new-password",
    });

    expect(updated?.authPassword).toBe("a-new-password");
  });

  it("finds it readable too, which is the contract the others now keep", async () => {
    const repo = await createRepository();
    mockCrypto();

    const created = await repo.create(managed);
    const found = await repo.findById(created.id, "user-1");

    expect(found?.authPassword).toBe("the-real-password");
  });
});
