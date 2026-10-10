/**
 * Moves each host's network out of ssh_data and into the vpn plugin's host
 * settings: vpn_profile_id becomes profileId.
 *
 * The column stays in the database, unused: core's drizzle migrations run
 * before this does, so dropping it there would lose the data first.
 *
 * Idempotent: a host that already has any vpn row is skipped, so this is safe
 * on every boot. It matters more than most -- a host whose network is lost
 * connects directly, out of the server's own route, which is the one thing a
 * host pointed at someone else's network must never do.
 */

import { sql } from "drizzle-orm";
import { databaseLogger } from "../utils/logger.js";
import {
  createCurrentPluginRepository,
  createCurrentPluginSettingsRepository,
} from "../database/repositories/factory.js";
import { selectRows } from "../utils/crypto-migration/raw-rows.js";

const PLUGIN_ID = "vpn";

interface LegacyHostRow {
  id: number;
  vpn_profile_id: number | string | null;
}

/** The plugin's host settings for one legacy row, or nothing to write. */
export function vpnSettingsFromRow(
  row: LegacyHostRow,
): Record<string, unknown> {
  const id = Number(row.vpn_profile_id);
  return Number.isInteger(id) && id > 0 ? { profileId: id } : {};
}

export interface VpnSettingsMigrationResult {
  hostsMoved: number;
  hostsSkipped: number;
}

export async function runVpnSettingsMigration(): Promise<VpnSettingsMigrationResult> {
  const result: VpnSettingsMigrationResult = {
    hostsMoved: 0,
    hostsSkipped: 0,
  };

  // plugin_settings has a foreign key to plugins: nothing to migrate into
  // until the plugin row exists.
  try {
    const plugin = await createCurrentPluginRepository().findById(PLUGIN_ID);
    if (!plugin) return result;
  } catch {
    return result;
  }

  const pluginSettings = createCurrentPluginSettingsRepository();

  let rows: LegacyHostRow[];
  try {
    // Raw SQL: schema.ts no longer declares the column.
    rows = await selectRows<LegacyHostRow>(
      sql`SELECT id, vpn_profile_id FROM ssh_data`,
    );
  } catch {
    // A fresh install never had the column.
    return result;
  }

  for (const row of rows) {
    const values = vpnSettingsFromRow(row);
    if (Object.keys(values).length === 0) continue;
    const scopeId = String(row.id);
    try {
      const existing = await pluginSettings.getAll(PLUGIN_ID, "host", scopeId);
      if (existing.length > 0) {
        result.hostsSkipped++;
        continue;
      }
      for (const [key, value] of Object.entries(values)) {
        await pluginSettings.set(
          PLUGIN_ID,
          "host",
          scopeId,
          key,
          JSON.stringify(value),
        );
      }
      result.hostsMoved++;
    } catch (error) {
      databaseLogger.warn("VPN host settings migration failed for a host", {
        operation: "vpn_settings_migration",
        hostId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (result.hostsMoved > 0) {
    databaseLogger.info(
      `Moved the network of ${result.hostsMoved} host(s) into plugin settings`,
      { operation: "vpn_settings_migration" },
    );
  }
  return result;
}
