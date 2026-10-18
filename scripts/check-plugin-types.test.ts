/**
 * The gate that would have caught a plugin frozen against an older SDK.
 *
 * `tsc -b` at the root covers src/ and the SDK, not plugins/: each plugin has
 * a tsconfig of its own so it keeps building if it moves out of this repo.
 * Nothing else looked at them -- esbuild does not type-check, and a plugin's
 * vitest suite only type-checks the files its tests import.
 *
 * ssh-terminal is carried here with local patches, frozen at the 2.9.2 SDK.
 * 26.10 renamed useConfirmation to useConfirm, and importing a name a module
 * does not export fails in the browser at link time, not at build time: the
 * backend activated, the Plugins page said Running, and the plugin's whole
 * frontend never ran. Clicking a host did nothing, because the action that
 * opens the terminal was never registered. Every check in CI was green.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { pluginDirs, typecheckCommand, SCRIPT } =
  require("./check-plugin-types.cjs") as {
    pluginDirs: () => string[];
    typecheckCommand: (
      dir: string,
    ) => { command: string; args: string[] } | null;
    SCRIPT: string;
  };

describe("the plugin type-check gate", () => {
  it("finds every plugin in the tree", () => {
    const found = pluginDirs()
      .map((dir) => path.basename(dir))
      .sort();
    expect(found).toEqual([
      "desktop-stream",
      "rdp-direct",
      "session-recording",
      "ssh-terminal",
      "vpn",
    ]);
  });

  it("runs each one's own script, not a tsconfig of its own invention", () => {
    for (const dir of pluginDirs()) {
      const command = typecheckCommand(dir);
      expect(command, path.basename(dir)).not.toBeNull();
      expect(command!.args).toEqual(["run", SCRIPT]);
    }
  });

  it("holds every plugin to declaring that script", () => {
    // Skipping silently is how this gap went unnoticed for a release.
    for (const dir of pluginDirs()) {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(dir, "package.json"), "utf8"),
      );
      expect(pkg.scripts?.[SCRIPT], path.basename(dir)).toBeTruthy();
    }
  });

  it("is wired into type-check, where CI runs it", () => {
    const pkg = JSON.parse(
      fs.readFileSync(
        path.join(import.meta.dirname, "../package.json"),
        "utf8",
      ),
    );
    expect(pkg.scripts["type-check"]).toContain("check-plugin-types.cjs");
  });

  it("asks for nothing from a directory that is not a plugin", () => {
    expect(
      typecheckCommand(path.join(import.meta.dirname, "..", "src")),
    ).toBeNull();
  });
});
