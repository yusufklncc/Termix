import { describe, expect, it } from "vitest";
import { resolveTunnelEndpoint } from "../../src/backend/tunnel-endpoint";

/**
 * Where the tunnel may listen depends on who has to reach it.
 *
 * The bridge dials a host and a port and can act on nothing else, so a jump
 * chain or a VPN is put behind a local listener. Binding that to loopback
 * when the bridge is in another container would hand it an address it cannot
 * reach, and binding to every interface when it is in this one would publish
 * a way into the host for no reason.
 */
describe("resolveTunnelEndpoint", () => {
  it("keeps a bridge in this namespace on loopback", () => {
    for (const host of ["localhost", "127.0.0.1", "::1", "LOCALHOST"]) {
      expect(resolveTunnelEndpoint(host)).toEqual({
        bindHost: "127.0.0.1",
        advertisedHost: "127.0.0.1",
      });
    }
  });

  it("gives a bridge in another container a name it can resolve", () => {
    expect(resolveTunnelEndpoint("termix-rdp-bridge")).toEqual({
      bindHost: "0.0.0.0",
      advertisedHost: "termix",
    });
  });

  it("takes the operator's name for this container when given one", () => {
    expect(resolveTunnelEndpoint("termix-rdp-bridge", "termix-app")).toEqual({
      bindHost: "0.0.0.0",
      advertisedHost: "termix-app",
    });
  });
});
