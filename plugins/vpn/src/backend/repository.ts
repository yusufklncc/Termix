import { and, eq } from "drizzle-orm";
import type { PluginContext } from "@termix/plugin-sdk/backend";
import { vpnProfiles } from "./tables.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
// The table comes from ctx.db.define, which the SDK hands back untyped, and
// the drizzle handle is the server's own. Typed at this module's edge.
type Table = any;
type Drizzle = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface VpnProfileRecord {
  id: number;
  userId: string;
  name: string;
  description: string | null;
  folder: string | null;
  tags: string | null;
  kind: string;
  gatewayType: string;
  gatewayHost: string;
  gatewayPort: number;
  gatewayUsername: string | null;
  gatewayPassword: string | null;
  provider: string | null;
  serverHost: string | null;
  serverPort: number | null;
  authUsername: string | null;
  authPassword: string | null;
  trustedFingerprint: string | null;
  extraConfig: string | null;
  enabled: boolean;
  lastState: string | null;
  lastError: string | null;
}

/**
 * The profiles, as rows.
 *
 * No encryption here any more: the secret columns are declared encryptedText,
 * so what goes in comes back out and the key handling is core's. The fork's
 * old repository did it by hand and once returned ciphertext as a password,
 * which is the kind of thing that stops being possible when one layer owns it.
 */
export class VpnProfileRepository {
  private table: Table | null = null;

  constructor(private readonly ctx: PluginContext) {}

  private async handles(): Promise<{ db: Drizzle; table: Table }> {
    this.table ??= await this.ctx.db.define(vpnProfiles);
    return { db: await this.ctx.db.client<Drizzle>(), table: this.table };
  }

  /** Written after every write: on SQLite an unflushed row is lost on restart. */
  private async flush(): Promise<void> {
    await this.ctx.db.persist();
  }

  async list(userId: string): Promise<VpnProfileRecord[]> {
    const { db, table } = await this.handles();
    return db.select().from(table).where(eq(table.userId, userId));
  }

  /** Scoped to the owner: a profile reaches a gateway with stored credentials. */
  async findById(id: number, userId: string): Promise<VpnProfileRecord | null> {
    const { db, table } = await this.handles();
    const rows = await db
      .select()
      .from(table)
      .where(and(eq(table.id, id), eq(table.userId, userId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * By name, for a host that arrived from somewhere else.
   *
   * An exported host carries the profile's name, because its id means
   * nothing outside the account it came from. Names are not unique in the
   * table, so the oldest match wins -- arbitrary, but stable, which matters
   * more than which one when a person has two networks of the same name.
   */
  async findByName(
    name: string,
    userId: string,
  ): Promise<VpnProfileRecord | null> {
    const { db, table } = await this.handles();
    const rows = await db
      .select()
      .from(table)
      .where(and(eq(table.userId, userId), eq(table.name, name)))
      .orderBy(table.id)
      .limit(1);
    return rows[0] ?? null;
  }

  /** Every managed profile, across users, for the boot-time resync. */
  async listManaged(): Promise<VpnProfileRecord[]> {
    const { db, table } = await this.handles();
    return db.select().from(table).where(eq(table.kind, "managed"));
  }

  async create(input: Partial<VpnProfileRecord>): Promise<VpnProfileRecord> {
    const { db, table } = await this.handles();
    const rows = await db.insert(table).values(input).returning();
    await this.flush();
    return rows[0];
  }

  async updateById(
    id: number,
    userId: string,
    patch: Partial<VpnProfileRecord>,
  ): Promise<VpnProfileRecord | null> {
    const { db, table } = await this.handles();
    const rows = await db
      .update(table)
      .set(patch)
      .where(and(eq(table.id, id), eq(table.userId, userId)))
      .returning();
    await this.flush();
    return rows[0] ?? null;
  }

  async deleteById(id: number, userId: string): Promise<boolean> {
    const { db, table } = await this.handles();
    const rows = await db
      .delete(table)
      .where(and(eq(table.id, id), eq(table.userId, userId)))
      .returning();
    await this.flush();
    return rows.length > 0;
  }
}
