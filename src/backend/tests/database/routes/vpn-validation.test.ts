import { describe, expect, it } from "vitest";
import { findVpnProfileError } from "../../../database/routes/vpn-validation.js";

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
