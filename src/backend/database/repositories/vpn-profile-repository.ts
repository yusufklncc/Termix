import { desc, eq } from "drizzle-orm";
import { DataCrypto } from "../../utils/data-crypto.js";
import { vpnProfiles } from "../db/schema.js";
import type { DatabaseContext } from "./database-context.js";
import { rowsAffected } from "./mutation-result.js";
import {
  deleteReturning,
  insertReturning,
  updateReturning,
} from "./returning.js";

/**
 * Profiles describing a network a host is reached through.
 *
 * Owned by a user, like vault profiles: a tunnel carries someone's access to
 * someone else's network, so it is not shared implicitly. Sharing, if it is
 * ever wanted, is a deliberate later decision.
 */

export type VpnProfileRecord = typeof vpnProfiles.$inferSelect;

export interface VpnProfileCreateInput {
  userId: string;
  name: string;
  description?: string | null;
  folder?: string | null;
  tags?: string | null;
  kind?: string;
  gatewayType?: string;
  gatewayHost: string;
  gatewayPort: number;
  gatewayUsername?: string | null;
  gatewayPassword?: string | null;
}

export type VpnProfileUpdateInput = Partial<
  Omit<VpnProfileCreateInput, "userId">
> & {
  updatedAt?: string;
};

export class VpnProfileRepository {
  constructor(
    private readonly context: DatabaseContext,
    private readonly onWrite?: () => void | Promise<void>,
  ) {}

  async listByUser(userId: string): Promise<VpnProfileRecord[]> {
    const rows = await this.context.drizzle
      .select()
      .from(vpnProfiles)
      .where(eq(vpnProfiles.userId, userId))
      .orderBy(desc(vpnProfiles.updatedAt));

    const userDataKey = DataCrypto.getUserDataKey(userId);
    return DataCrypto.decryptRecords("vpn_profiles", rows, userId, userDataKey);
  }

  async create(input: VpnProfileCreateInput): Promise<VpnProfileRecord> {
    // The gateway password is a secret like any host credential; the table is
    // registered in field-crypto, and this is where that registration is used.
    const userDataKey = DataCrypto.validateUserAccess(input.userId);
    const record = DataCrypto.encryptRecord(
      "vpn_profiles",
      {
        userId: input.userId,
        name: input.name,
        description: input.description,
        folder: input.folder,
        tags: input.tags,
        kind: input.kind ?? "declared",
        gatewayType: input.gatewayType ?? "socks5",
        gatewayHost: input.gatewayHost,
        gatewayPort: input.gatewayPort,
        gatewayUsername: input.gatewayUsername,
        gatewayPassword: input.gatewayPassword,
      },
      input.userId,
      userDataKey,
    );

    const [created] = await insertReturning(this.context, vpnProfiles, record);
    await this.afterWrite();
    return created;
  }

  async findById(id: number): Promise<VpnProfileRecord | null> {
    const rows = await this.context.drizzle
      .select()
      .from(vpnProfiles)
      .where(eq(vpnProfiles.id, id))
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    const userDataKey = DataCrypto.getUserDataKey(row.userId);
    return DataCrypto.decryptRecord(
      "vpn_profiles",
      row,
      row.userId,
      userDataKey,
    );
  }

  async updateById(
    id: number,
    userId: string,
    input: VpnProfileUpdateInput,
  ): Promise<VpnProfileRecord | null> {
    const userDataKey = DataCrypto.validateUserAccess(userId);
    const patch = DataCrypto.encryptRecord(
      "vpn_profiles",
      { ...input, updatedAt: input.updatedAt ?? new Date().toISOString() },
      userId,
      userDataKey,
    );

    const [updated] = await updateReturning(
      this.context,
      vpnProfiles,
      patch,
      eq(vpnProfiles.id, id),
    );

    if (updated) await this.afterWrite();
    return updated ?? null;
  }

  async deleteById(id: number): Promise<boolean> {
    const rows = await deleteReturning(
      this.context,
      vpnProfiles,
      eq(vpnProfiles.id, id),
    );

    if (rows.length === 0) return false;
    await this.afterWrite();
    return true;
  }

  async deleteByUserId(userId: string): Promise<number> {
    const result = await this.context.drizzle
      .delete(vpnProfiles)
      .where(eq(vpnProfiles.userId, userId));

    if (rowsAffected(result) > 0) await this.afterWrite();
    return rowsAffected(result);
  }

  private async afterWrite(): Promise<void> {
    await this.onWrite?.();
  }
}
