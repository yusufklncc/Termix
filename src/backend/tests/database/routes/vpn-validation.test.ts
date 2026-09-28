import { describe, expect, it } from "vitest";
import {
  findVpnProfileError,
  vpnProfileAssignmentError,
} from "../../../database/routes/vpn-validation.js";

/** What a network needs now that Termix raises the tunnel itself. */
const valid = {
  name: "Company X",
  kind: "managed",
  provider: "fortinet",
  serverHost: "vpn.company-x.example",
  serverPort: 443,
  authUsername: "someone",
};

describe("findVpnProfileError", () => {
  it("accepts a network Termix can raise", () => {
    expect(findVpnProfileError(valid)).toBeNull();
  });

  it("requires a name", () => {
    expect(findVpnProfileError({ ...valid, name: "  " })).toMatch(/name/i);
  });

  it("requires the gateway's address", () => {
    // Without one there is nothing to dial, and the profile would exist only
    // to make hosts on it refuse.
    expect(findVpnProfileError({ ...valid, serverHost: "" })).toMatch(
      /gateway's address/i,
    );
  });

  it("requires an account to sign in as", () => {
    expect(findVpnProfileError({ ...valid, authUsername: "" })).toMatch(
      /username/i,
    );
  });

  it("requires a usable port when one is given", () => {
    for (const serverPort of [0, -1, 70000, 443.5, "443"]) {
      expect(findVpnProfileError({ ...valid, serverPort })).toMatch(/port/i);
    }
  });

  it("rejects a provider nothing implements", () => {
    // Accepting it would promise a tunnel the manager does not know how to
    // raise.
    expect(
      findVpnProfileError({ ...valid, provider: "carrier-pigeon" }),
    ).toMatch(/provider/i);
  });

  /**
   * The sidecar arrangement, closed off. Rows made under it still resolve --
   * a network someone is connecting through is not a thing to break on an
   * upgrade -- but there is nothing to gain by making another.
   */
  it("no longer takes an operator-run sidecar", () => {
    expect(findVpnProfileError({ ...valid, kind: "declared" })).toMatch(
      /no longer/i,
    );
  });

  it("rejects a kind that means nothing", () => {
    expect(findVpnProfileError({ ...valid, kind: "wireguard" })).toMatch(
      /profile kind/i,
    );
  });
});

describe("vpnProfileAssignmentError", () => {
  const found = async () => ({ id: 1 });
  const missing = async () => null;

  it("allows a host with no network", async () => {
    expect(await vpnProfileAssignmentError(undefined, "u", missing)).toBeNull();
    expect(await vpnProfileAssignmentError(null, "u", missing)).toBeNull();
  });

  it("allows a profile the owner has", async () => {
    expect(await vpnProfileAssignmentError(3, "u", found)).toBeNull();
  });

  it("refuses a profile the owner does not have", async () => {
    expect(await vpnProfileAssignmentError(3, "u", missing)).toMatch(
      /not found/i,
    );
  });

  it("asks under the owner, not whoever is saving", async () => {
    const asked: Array<[number, string]> = [];
    await vpnProfileAssignmentError(5, "owner-2", async (id, userId) => {
      asked.push([id, userId]);
      return { id };
    });
    expect(asked).toEqual([[5, "owner-2"]]);
  });

  it("refuses something that is not an id", async () => {
    expect(await vpnProfileAssignmentError("abc", "u", found)).toMatch(
      /invalid/i,
    );
  });
});
