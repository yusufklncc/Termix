/**
 * The envelopes core left behind when the VPN moved into a plugin.
 *
 * Core encrypted this table's three secret columns under the owner's own key;
 * the plugin does not, so a row written before the move still holds the
 * envelope and nothing decrypts it. Handing that to a gateway looks like a
 * wrong password. The real case: a NetBird setup key came back as "invalid
 * UUID length: 270", which is exactly what a 36-character UUID measures once
 * core has wrapped it.
 */

import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertSecretsReadable,
  isLegacyEnvelope,
} from "../../src/backend/legacy-secrets.js";

/** Byte for byte what FieldCrypto.encryptField wrote. */
function coreEnvelope(plaintext: string, recordId = "temp-" + Date.now()) {
  const master = crypto.randomBytes(32);
  const salt = crypto.randomBytes(32);
  const key = Buffer.from(
    crypto.hkdfSync("sha256", master, salt, `${recordId}:authPassword`, 32),
  );
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  let data = cipher.update(plaintext, "utf8", "hex");
  data += cipher.final("hex");
  return JSON.stringify({
    data,
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    salt: salt.toString("hex"),
    recordId,
  });
}

describe("isLegacyEnvelope", () => {
  it("knows one of core's envelopes", () => {
    expect(isLegacyEnvelope(coreEnvelope(crypto.randomUUID()))).toBe(true);
  });

  it("measures the setup key that failed in the field", () => {
    // The number in NetBird's refusal, reproduced rather than remembered.
    const envelope = coreEnvelope(crypto.randomUUID(), "temp-1760000000000");
    expect(envelope).toHaveLength(270);
    expect(isLegacyEnvelope(envelope)).toBe(true);
  });

  it("leaves a password someone typed alone", () => {
    for (const value of [
      crypto.randomUUID(),
      "hunter2",
      "{not json",
      "",
      null,
      undefined,
    ]) {
      expect(isLegacyEnvelope(value)).toBe(false);
    }
  });

  it("leaves extraConfig's own JSON alone", () => {
    // This column legitimately holds JSON, so the envelope's four keys all
    // have to be present -- "it parses" is not enough.
    const config = JSON.stringify({
      setupKey: crypto.randomUUID(),
      managementUrl: "https://netbird.example.com",
      data: "something",
    });
    expect(isLegacyEnvelope(config)).toBe(false);
  });
});

describe("assertSecretsReadable", () => {
  it("says what to do rather than letting the gateway refuse it", () => {
    expect(() =>
      assertSecretsReadable({ authPassword: coreEnvelope("a-setup-key") }),
    ).toThrow(/enter them again/i);
  });

  it("checks every column core used to encrypt", () => {
    for (const field of ["gatewayPassword", "authPassword", "extraConfig"]) {
      expect(() =>
        assertSecretsReadable({ [field]: coreEnvelope("secret") }),
      ).toThrow();
    }
  });

  it("passes a profile saved since the move", () => {
    expect(() =>
      assertSecretsReadable({
        gatewayPassword: "plain",
        authPassword: crypto.randomUUID(),
        extraConfig: JSON.stringify({ hostname: "termix-7" }),
      }),
    ).not.toThrow();
  });
});
