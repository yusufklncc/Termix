/**
 * That the tab is this plugin's own, and that it preloads.
 *
 * Both were once untrue. While the direct renderer rode on the remote-desktop
 * plugin's `rdp` tab type, hovering a direct host downloaded Guacamole and
 * not this; the 2.9 move gave it a type of its own and fixed that as a side
 * effect. Preloading is invisible either way -- the tab opens, just later --
 * so nothing would report it going missing again.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix/plugin-sdk/testing";
import type { PluginManifest } from "@termix/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
});

describe("activate", () => {
  it("registers a tab under this plugin's own id", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });

    // Not "rdp": that one belongs to remote-desktop and takes Guacamole with
    // it.
    expect(rendered.registered.tabs()).toContain("rdp-direct");
    expect(rendered.registered.tabs()).not.toContain("rdp");
  });

  it("declares a preload for it", () => {
    // The harness reports a tab's id and nothing else, so the registration is
    // read here. preloadTabSurface does nothing without this: it looks up
    // getTabType(type)?.preload and gives up when there is none.
    const source = readFileSync(
      path.join(import.meta.dirname, "../../src/frontend/index.tsx"),
      "utf8",
    );
    const registration = source.slice(source.indexOf("app.registerTab("));
    expect(registration.slice(0, registration.indexOf("});"))).toMatch(
      /preload:\s*\(\)\s*=>\s*import\(/,
    );
  });
});
