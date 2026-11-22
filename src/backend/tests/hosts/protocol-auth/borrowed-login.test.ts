/**
 * Fork: Direct RDP signs in with RDP's login (loginFrom), and the 26.11
 * layouts send null for every protocol whose switch is off. With RDP off and
 * Direct RDP on, every save deleted that login, and what was typed into
 * Direct RDP's login section went with it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../database/db/index.js", () => ({ getDb: () => ({}) }));
vi.mock("../../../hosts/usable-credential.js", () => ({
  findUsableCredential: async () => null,
}));

import { readProtocolAuthPayload } from "../../../hosts/protocol-auth/protocol-auth.js";
import {
  setHostProtocolSource,
  type DeclaredHostProtocol,
} from "../../../hosts/protocol-auth/registry.js";

const RDP: DeclaredHostProtocol = {
  id: "rdp",
  credentialFields: [{ key: "domain" }],
  pluginId: "remote-desktop",
  pluginName: "Remote Desktop",
};
const RDP_DIRECT: DeclaredHostProtocol = {
  id: "rdp-direct",
  loginFrom: "rdp",
  pluginId: "rdp-direct",
  pluginName: "Direct RDP",
} as DeclaredHostProtocol;

beforeEach(() => setHostProtocolSource(() => [RDP, RDP_DIRECT]));
afterEach(() => setHostProtocolSource(() => []));

const read = (protocolAuth: Record<string, unknown>) => {
  const patch = readProtocolAuthPayload({ protocolAuth });
  return patch ? Object.fromEntries(patch) : null;
};

const login = {
  authType: "direct",
  username: "yusuf",
  fields: { domain: "D" },
};

describe("RDP off, Direct RDP on", () => {
  it("keeps the RDP login the layout asks to delete", () => {
    expect(read({ rdp: null })).toBeNull();
  });

  it("writes what Direct RDP's section sent to the RDP login", () => {
    expect(read({ rdp: null, "rdp-direct": login })).toEqual({ rdp: login });
  });
});

describe("RDP on", () => {
  it("lets RDP's own form win over a copy under Direct RDP", () => {
    const own = { ...login, username: "from-rdp-form" };
    expect(read({ rdp: own, "rdp-direct": login })).toEqual({ rdp: own });
  });

  it("is untouched with Direct RDP off", () => {
    expect(read({ rdp: login, "rdp-direct": null })).toEqual({
      rdp: login,
      "rdp-direct": null,
    });
  });
});

describe("both off", () => {
  it("deletes the login, as upstream intends", () => {
    expect(read({ rdp: null, "rdp-direct": null })).toEqual({
      rdp: null,
      "rdp-direct": null,
    });
  });
});

describe("without Direct RDP installed", () => {
  it("is upstream's behaviour exactly", () => {
    setHostProtocolSource(() => [RDP]);
    expect(read({ rdp: null })).toEqual({ rdp: null });
  });
});
