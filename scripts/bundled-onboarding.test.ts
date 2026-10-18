/**
 * A fresh install's answer for the plugins this fork ships itself.
 *
 * initialPluginState only consults the onboarding defaults on a fresh
 * install; after that a new plugin arriving in an existing install starts
 * enabled. So a bundled plugin with no onboarding entry works everywhere
 * except on a first boot, where it is inserted disabled and the picker never
 * offers it -- a fork whose whole point is its own plugins would come up with
 * them off, and nothing in the interface would say why.
 *
 * Three of ours had no entry. session-recording is upstream's and has none
 * there either, so it is listed as deliberately left alone rather than
 * forgotten.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { loadBundledPlugins } = require("./lib/bundled-plugins.cjs") as {
  loadBundledPlugins: (root: string) => Array<{
    id: string;
    source: string;
    onboarding: {
      recommended?: boolean | "desktop";
      consent?: boolean;
    } | null;
  }>;
};

const ROOT = path.join(import.meta.dirname, "..");

/** Upstream's own, patched here but not ours to recommend. */
const UPSTREAM_CHOICE = new Set(["session-recording"]);

function workspacePlugins() {
  return loadBundledPlugins(ROOT).filter(
    (plugin) => plugin.source === "workspace",
  );
}

describe("the plugins this fork builds in tree", () => {
  it("are all accounted for", () => {
    // So adding one and forgetting the list below fails here.
    expect(
      workspacePlugins()
        .map((plugin) => plugin.id)
        .sort(),
    ).toEqual([
      "desktop-stream",
      "rdp-direct",
      "session-recording",
      "ssh-terminal",
      "vpn",
    ]);
  });

  it("are offered on a fresh install", () => {
    for (const plugin of workspacePlugins()) {
      if (UPSTREAM_CHOICE.has(plugin.id)) continue;
      expect(plugin.onboarding, plugin.id).not.toBeNull();
      expect(plugin.onboarding?.recommended, plugin.id).toBe(true);
    }
  });

  it("start without waiting for a consent prompt", () => {
    // recommended with consent means "checked, but still waits for the
    // admin's choice", which is initialPluginState's disabled branch.
    for (const plugin of workspacePlugins()) {
      if (UPSTREAM_CHOICE.has(plugin.id)) continue;
      expect(plugin.onboarding?.consent, plugin.id).toBe(false);
    }
  });

  it("leaves session-recording as upstream has it", () => {
    const found = workspacePlugins().find(
      (plugin) => plugin.id === "session-recording",
    );
    expect(found?.onboarding).toBeNull();
  });
});
