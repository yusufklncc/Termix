import { afterEach, describe, expect, it, vi } from "vitest";
import { TestSqliteDatabase } from "./test-support.js";
import { VpnProfileRepository } from "../../../database/repositories/vpn-profile-repository.js";
import { vpnProfiles } from "../../../database/db/schema.js";
import { DataCrypto } from "../../../utils/data-crypto.js";

describe("VpnProfileRepository", () => {
  let adapter: TestSqliteDatabase | null = null;

  afterEach(async () => {
    if (adapter) {
      await adapter.close();
      adapter = null;
    }
    vi.restoreAllMocks();
  });

  async function setup() {
    adapter = new TestSqliteDatabase();
    const context = await adapter.connect();
    await adapter.exec(`
      INSERT INTO users (id, username, password_hash)
      VALUES ('user-1', 'alice', 'hash');
    `);

    const key = Buffer.alloc(32, 1);
    vi.spyOn(DataCrypto, "validateUserAccess").mockReturnValue(key);
    vi.spyOn(DataCrypto, "getUserDataKey").mockReturnValue(key);

    return { context, repository: new VpnProfileRepository(context) };
  }

  it("writes the gateway password encrypted and reads it back", async () => {
    // Asserted against the stored column rather than the repository's own
    // output: the point is what lands on disk, not what the code intends.
    const { context, repository } = await setup();
    await repository.create({
      userId: "user-1",
      name: "Company X",
      gatewayHost: "vpn-x",
      gatewayPort: 1080,
      gatewayPassword: "s3cret",
    });

    const stored = await context.drizzle.select().from(vpnProfiles);
    expect(stored).toHaveLength(1);
    expect(stored[0].gatewayPassword).not.toBe("s3cret");
    expect(String(stored[0].gatewayPassword)).toContain("recordId");

    const listed = await repository.listByUser("user-1");
    expect(listed[0].gatewayPassword).toBe("s3cret");
    expect(listed[0].gatewayHost).toBe("vpn-x");
  });

  it("counts the hosts still reaching through a profile", async () => {
    const { repository } = await setup();
    const profile = await repository.create({
      userId: "user-1",
      name: "Company X",
      gatewayHost: "vpn-x",
      gatewayPort: 1080,
    });

    expect(await repository.countHostsUsing(profile.id)).toBe(0);

    await adapter!.exec(`
      INSERT INTO ssh_data (id, user_id, name, ip, port, username, auth_type, vpn_profile_id)
      VALUES
        (1, 'user-1', 'one', '10.0.0.1', 22, 'root', 'password', ${profile.id}),
        (2, 'user-1', 'two', '10.0.0.2', 22, 'root', 'password', ${profile.id}),
        (3, 'user-1', 'direct', '10.0.0.3', 22, 'root', 'password', NULL);
    `);

    // The route refuses to delete while this is above zero: the column is ON
    // DELETE SET NULL, so deleting would leave those hosts connecting directly
    // out of the server's own route, silently.
    expect(await repository.countHostsUsing(profile.id)).toBe(2);
  });

  it("keeps one user's profiles out of another's list", async () => {
    const { repository } = await setup();
    await adapter!.exec(`
      INSERT INTO users (id, username, password_hash)
      VALUES ('user-2', 'bob', 'hash');
    `);
    await repository.create({
      userId: "user-1",
      name: "Company X",
      gatewayHost: "vpn-x",
      gatewayPort: 1080,
    });

    expect(await repository.listByUser("user-2")).toHaveLength(0);
    expect(await repository.listByUser("user-1")).toHaveLength(1);
  });
});
