/**
 * Direct RDP takes its login from RDP.
 *
 * It is a second renderer for the same host, and the host editor only ever
 * offers RDP a login form. Without loginFrom it read a login saved under its
 * own id -- which nothing writes -- and fell back to the host's SSH login:
 * the wrong user for a Windows machine, and no password when SSH uses a key.
 * Reported in the field as "it does not know which credential to use".
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "../../manifest.json"), "utf8"),
);

describe("the rdp-direct protocol", () => {
  const protocol = manifest.contributes.protocols.find(
    (entry: { id: string }) => entry.id === "rdp-direct",
  );

  it("borrows the login of upstream's RDP protocol", () => {
    expect(protocol?.loginFrom).toBe("rdp");
  });

  it("declares the same login shape RDP does", () => {
    // Borrowed fields only arrive if this protocol declares them too.
    expect(protocol?.credentialFields).toEqual([{ key: "domain" }]);
  });
});
