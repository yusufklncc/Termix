import {
  adoptLegacyTable,
  boolean,
  defineTable,
  encryptedText,
  id,
  integer,
  refUser,
  text,
  timestamp,
} from "@termix-ssh/plugin-sdk/db";

/**
 * The networks hosts are reached through.
 *
 * Adopted from core's vpn_profiles, so the column names stay as they were and
 * a database that already holds profiles keeps them.
 *
 * Two kinds of secret live here and both are presented to a gateway rather
 * than verified, so both are encrypted and neither is hashed: the password of
 * a proxy an operator runs, and whatever a managed tunnel signs in with -- a
 * password, an auth key, a setup key.
 */
export const vpnProfiles = adoptLegacyTable(
  "vpn_profiles",
  defineTable(
    "vpn_profiles",
    {
      id: id(),
      userId: refUser(),
      name: text().notNull(),
      description: text(),
      folder: text(),
      tags: text(),
      kind: text().notNull().default("declared"),
      gatewayType: text().notNull().default("socks5"),
      gatewayHost: text().notNull(),
      gatewayPort: integer().notNull(),
      gatewayUsername: text(),
      gatewayPassword: encryptedText(),
      provider: text(),
      serverHost: text(),
      serverPort: integer(),
      authUsername: text(),
      authPassword: encryptedText(),
      trustedFingerprint: text(),
      extraConfig: encryptedText(),
      /**
       * Switched off by the operator, rather than failed.
       *
       * A tunnel that is up is a live path from this server into someone
       * else's network, whether anyone is using it or not. Taking one down
       * should not mean deleting the profile and its credentials.
       */
      enabled: boolean().notNull().default(true),
      // Last word from the manager, so the panel can say more than "saved".
      lastState: text(),
      lastError: text(),
      createdAt: timestamp().defaultNow(),
      updatedAt: timestamp().defaultNow(),
    },
    {
      indexes: [{ name: "idx_vpn_profiles_user", columns: ["userId"] }],
    },
  ),
);

/** Every table this plugin owns, for the migration generator. */
export const tables = [vpnProfiles];
