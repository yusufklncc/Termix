import { afterEach, describe, expect, it } from "vitest";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
});

/**
 * That activate registers what it says it does.
 *
 * Twice now a registration has gone missing from this file without anything
 * noticing: the code compiled, the plugin loaded, the backend answered, and
 * the only sign was a panel that was not there. Nothing else reads this, so
 * it is read here.
 */
describe("activate", () => {
  it("offers the VPNs destination and its panel", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });

    expect(rendered.registered.railItems()).toEqual([
      expect.objectContaining({ id: "vpn" }),
    ]);
    expect(rendered.registered.panels()).toEqual(["vpn"]);
  });

  // Not covered: that the item asks to stay in the Simple preset, which
  // otherwise hides every plugin item. The harness reports a rail item's id,
  // hidden and permission, and nothing else, so that flag is only readable
  // in the source.

  it("puts the host's network in the editor", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });

    expect(rendered.registered.hostEditorSections()).toEqual(["vpn"]);
  });
});
