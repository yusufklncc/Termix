/**
 * That the tab is this plugin's own, and that it preloads.
 *
 * Preloading is invisible: without it the tab still opens, only later, after
 * the bundle has been fetched on click. So nothing would report it going
 * missing, and the harness reports a tab's id and nothing else.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
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

describe("activate", () => {
  it("registers a tab under this plugin's own id", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });

    // Named desktop-stream, not stream: core already uses that word for a
    // connection profile.
    expect(rendered.registered.tabs()).toContain("desktop-stream");
  });

  it("declares a preload for it", () => {
    // preloadTabSurface does nothing without this: it looks up
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
