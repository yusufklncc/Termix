/**
 * A plugin whose build is more than the CLI call has to have its own build
 * run, or the extra step is silently skipped.
 *
 * rdp-direct generates its decoder worker with esbuild before building, and
 * the generated file is gitignored. While this script called the CLI
 * directly, the build passed on any machine that still had that file from an
 * earlier run and failed on a clean checkout -- which is where it shipped
 * from, and where CI eventually caught it.
 */

import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { pluginBuildCommand, PLAIN_BUILD } = require("./build-plugins.cjs") as {
  pluginBuildCommand: (dir: string) => { command: string; args: string[] };
  PLAIN_BUILD: string;
};

function pluginDir(build?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-build-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify(build === undefined ? {} : { scripts: { build } }),
  );
  return dir;
}

describe("pluginBuildCommand", () => {
  it("runs a plugin's own build when it declares more than the CLI call", () => {
    const { command, args } = pluginBuildCommand(
      pluginDir("node build-worker.mjs && termix-plugin build"),
    );
    expect(path.basename(command)).toMatch(/^npm(\.cmd)?$/);
    expect(args).toEqual(["run", "build"]);
  });

  it("calls the CLI directly for the build every other plugin declares", () => {
    const { command, args } = pluginBuildCommand(pluginDir(PLAIN_BUILD));
    expect(command).toBe(process.execPath);
    expect(args[0]).toMatch(/plugin-sdk[\\/]cli[\\/]index\.mjs$/);
    expect(args[1]).toBe("build");
  });

  it("falls back to the CLI when a plugin declares no build at all", () => {
    expect(pluginBuildCommand(pluginDir()).command).toBe(process.execPath);
    const missing = path.join(os.tmpdir(), "plugin-build-absent");
    expect(pluginBuildCommand(missing).command).toBe(process.execPath);
  });

  it("holds rdp-direct to declaring its worker step", () => {
    // The guard is only worth anything while the plugin it was written for
    // still needs it.
    const declared = JSON.parse(
      fs.readFileSync(
        path.join(import.meta.dirname, "../plugins/rdp-direct/package.json"),
        "utf8",
      ),
    ).scripts.build;
    expect(declared).toContain("build-worker.mjs");
    expect(declared).not.toBe(PLAIN_BUILD);
  });
});
