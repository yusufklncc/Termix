/**
 * The VPN plugin's screens run in a sandboxed frame from Termix 26.11.2: an
 * opaque origin with no cookies, and core reachable only through the shell's
 * short list. These say that nothing here needs more than that.
 */
import { describe, expect, it } from "vitest";
import { checkFrameApp, checkFrameViews } from "@termix-ssh/plugin-sdk/testing";
import * as plugin from "../../src/frontend/index";
import manifest from "../../manifest.json";

const host = {
  id: 1,
  name: "Test host",
  ip: "192.0.2.10",
  port: 22,
  username: "test",
  folder: "",
  tags: [],
  pluginSettings: {},
};

describe("in a frame", () => {
  it("activates", async () => {
    const { problems } = await checkFrameApp(plugin, {
      manifest: manifest as unknown as Record<string, unknown>,
    });
    expect(problems).toEqual([]);
  });

  it("asks core only for what a frame may reach", async () => {
    const { refused, errors } = await checkFrameViews(plugin, {
      manifest: manifest as unknown as Record<string, unknown>,
      hosts: [host],
    });
    expect(refused).toEqual([]);
    expect(errors).toEqual([]);
  });
});
