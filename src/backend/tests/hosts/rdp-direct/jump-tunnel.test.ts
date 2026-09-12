import { describe, expect, it } from "vitest";
import { parseJumpHosts } from "../../../hosts/rdp-direct/jump-tunnel.js";

describe("parseJumpHosts", () => {
  it("reads the stored JSON", () => {
    expect(parseJumpHosts('[{"hostId":3},{"hostId":7}]')).toEqual([
      { hostId: 3 },
      { hostId: 7 },
    ]);
  });

  it("passes an already-parsed array through", () => {
    expect(parseJumpHosts([{ hostId: 3 }])).toEqual([{ hostId: 3 }]);
  });

  it("treats nothing as no tunnel", () => {
    expect(parseJumpHosts(null)).toEqual([]);
    expect(parseJumpHosts(undefined)).toEqual([]);
    expect(parseJumpHosts("")).toEqual([]);
    expect(parseJumpHosts("[]")).toEqual([]);
  });

  it("treats a malformed value as no tunnel rather than failing the session", () => {
    // The column is written by the UI; an unreadable one should not lock a
    // host out of being opened at all.
    expect(parseJumpHosts("{not json")).toEqual([]);
    expect(parseJumpHosts('"a string"')).toEqual([]);
    expect(parseJumpHosts("null")).toEqual([]);
    expect(parseJumpHosts(42)).toEqual([]);
  });

  it("drops entries that name no host", () => {
    // A half-written entry would otherwise reach createJumpHostChain as
    // hostId: undefined and fail somewhere less obvious.
    expect(
      parseJumpHosts([
        { hostId: 3 },
        { hostId: "4" },
        { name: "bastion" },
        null,
        { hostId: 1.5 },
      ]),
    ).toEqual([{ hostId: 3 }]);
  });
});
