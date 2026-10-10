import { describe, expect, it } from "vitest";
import { addressIsInsideNetwork } from "../../src/backend/helpers";

/**
 * Whether the address means anything out here.
 *
 * This decision has been lost twice -- once in core, once again when the
 * terminal moved into this plugin -- and each time the symptom was the same:
 * a host addressed by its mesh name failed with ENOTFOUND before the tunnel
 * that would have resolved it was built, while the very same host connected
 * fine by IP.
 */
describe("addressIsInsideNetwork", () => {
  it("says so for a host on a VPN", () => {
    expect(addressIsInsideNetwork({ vpnProfileId: 3 })).toBe(true);
  });

  it("says so for a host behind a proxy", () => {
    expect(addressIsInsideNetwork({ useSocks5: true })).toBe(true);
  });

  it("says nothing of the kind for a host reached directly", () => {
    expect(addressIsInsideNetwork({})).toBe(false);
    expect(
      addressIsInsideNetwork({ vpnProfileId: null, useSocks5: false }),
    ).toBe(false);
  });
});
