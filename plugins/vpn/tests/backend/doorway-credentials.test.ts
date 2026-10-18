/**
 * The credential a managed profile's doorway asks for.
 *
 * The doorway used to be a bare pipe on 0.0.0.0:20000+id. Connecting was
 * enough to reach a customer's VPN, and enough to make the manager raise the
 * tunnel, so any container sharing the Docker network had both for the cost
 * of one `nc`. Now it speaks SOCKS5 username/password and answers it itself.
 *
 * Neither side stores the password: both derive it from the manager's token.
 * That is the fragile part. If the two derivations ever disagree, every
 * managed profile stops connecting at once, and the error a person would see
 * is a refused proxy -- which reads like a VPN that is down. So the
 * manager's own parameters are read out of its source here and compared.
 */

import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  managedDoorPassword,
  MANAGED_DOORWAY_USER,
} from "../../src/backend/net-manager-client.js";

const MANAGER = path.join(
  import.meta.dirname,
  "../../../../docker/net-manager/manager.js",
);

function managerSource(): string {
  return readFileSync(MANAGER, "utf8");
}

describe("the doorway password", () => {
  it("is the same for the same profile and token", () => {
    expect(managedDoorPassword(7, "a-token")).toBe(
      managedDoorPassword(7, "a-token"),
    );
  });

  it("differs per profile, so one customer's door is not another's", () => {
    expect(managedDoorPassword(7, "a-token")).not.toBe(
      managedDoorPassword(8, "a-token"),
    );
  });

  it("differs per token", () => {
    expect(managedDoorPassword(7, "a-token")).not.toBe(
      managedDoorPassword(7, "another-token"),
    );
  });

  it("is a 32-byte key, not something guessable", () => {
    const password = managedDoorPassword(7, "a-token");
    expect(password).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the two sides agree", () => {
  it("derives from the parameters the manager uses", () => {
    const source = managerSource();

    // Read the manager's own hkdfSync call rather than trusting a comment.
    const call = source.slice(source.indexOf("function doorwayPassword"));
    const body = call.slice(0, call.indexOf("\n}"));

    expect(body).toContain('"sha256"');
    expect(body).toContain('"termix-net-manager"');
    expect(body).toContain("`doorway:${id}`");
    expect(body).toContain("32");
    expect(body).toContain('toString("hex")');
    // Wrapped, or hkdfSync's ArrayBuffer stringifies to "[object
    // ArrayBuffer]" -- the same password for every profile, on both sides,
    // which agree and are worthless.
    expect(body).toContain("Buffer.from(");

    // And that the client produces what those parameters produce.
    const expected = Buffer.from(
      crypto.hkdfSync(
        "sha256",
        Buffer.from("a-token", "utf8"),
        Buffer.from("termix-net-manager", "utf8"),
        Buffer.from("doorway:7", "utf8"),
        32,
      ),
    ).toString("hex");
    expect(managedDoorPassword(7, "a-token")).toBe(expected);
  });

  it("asks for the account the manager expects", () => {
    expect(managerSource()).toContain(
      `const DOORWAY_USER = "${MANAGED_DOORWAY_USER}"`,
    );
  });
});

describe("the doorway itself", () => {
  it("authenticates before it raises the tunnel", () => {
    // Raising costs a gateway login and a use of a setup key. An
    // unauthenticated connection used to spend both.
    const source = managerSource();
    const handler = source.slice(source.indexOf("function openDoorway"));
    const auth = handler.indexOf("authenticateDoorway");
    const raise = handler.indexOf("raiseTunnel");

    expect(auth).toBeGreaterThan(-1);
    expect(raise).toBeGreaterThan(-1);
    expect(auth).toBeLessThan(raise);
  });

  it("refuses a client that will not do username/password", () => {
    const source = managerSource();
    // 0xff is SOCKS5 for "no acceptable method".
    expect(source).toContain("0x05, 0xff");
  });

  it("compares the password in constant time", () => {
    expect(managerSource()).toContain("timingSafeEqual");
  });
});
