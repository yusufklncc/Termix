import { describe, expect, it } from "vitest";
import {
  findVpnProfileError,
  vpnProfileAssignmentError,
} from "../../../database/routes/vpn-validation.js";

const valid = {
  name: "Company X",
  gatewayHost: "vpn-x",
  gatewayPort: 1080,
};

describe("findVpnProfileError", () => {
  it("accepts a profile that names a gateway", () => {
    expect(findVpnProfileError(valid)).toBeNull();
  });

  it("requires a name", () => {
    expect(findVpnProfileError({ ...valid, name: "  " })).toMatch(/name/i);
  });

  it("requires a gateway address", () => {
    // Without one the host would be marked as going through a network it has
    // no way to enter, and would connect directly instead.
    expect(findVpnProfileError({ ...valid, gatewayHost: "" })).toMatch(
      /gateway address/i,
    );
  });

  it("requires a usable port", () => {
    for (const gatewayPort of [0, -1, 70000, 1080.5, "1080"]) {
      expect(findVpnProfileError({ ...valid, gatewayPort })).toMatch(/port/i);
    }
  });

  it("rejects a gateway type nothing speaks", () => {
    expect(
      findVpnProfileError({ ...valid, gatewayType: "carrier-pigeon" }),
    ).toMatch(/gateway type/i);
  });

  it("rejects a managed kind while only declared tunnels exist", () => {
    // Accepting it would promise a tunnel Termix does not yet run.
    expect(findVpnProfileError({ ...valid, kind: "wireguard" })).toMatch(
      /profile kind/i,
    );
  });

  it("accepts the kinds and types that are implemented", () => {
    expect(findVpnProfileError({ ...valid, kind: "declared" })).toBeNull();
    expect(findVpnProfileError({ ...valid, gatewayType: "http" })).toBeNull();
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
