/**
 * A plugin that needs a step before the CLI builds it has to get it, or the
 * step is silently skipped.
 *
 * rdp-direct generates its decoder worker with esbuild, and the generated
 * file is gitignored. While this script called the CLI straight away, the
 * build passed on any machine that still had that file from an earlier run
 * and failed on a clean checkout -- which is where it shipped from, and where
 * CI eventually caught it.
 *
 * The step is a script of its own, and the CLI is still invoked by path.
 * Delegating the whole thing to `npm run build` was the first fix and it
 * broke the image: that resolves `termix-plugin` through node_modules/.bin,
 * which the Docker stage installing dependencies does not have.
 */

import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { pluginPrepareCommand, PREPARE_SCRIPT } =
  require("./build-plugins.cjs") as {
    pluginPrepareCommand: (
      dir: string,
    ) => { command: string; args: string[] } | null;
    PREPARE_SCRIPT: string;
  };

function pluginDir(scripts?: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-build-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify(scripts ? { scripts } : {}),
  );
  return dir;
}

describe("pluginPrepareCommand", () => {
  it("runs the step a plugin declares", () => {
    const command = pluginPrepareCommand(
      pluginDir({ [PREPARE_SCRIPT]: "node build-worker.mjs" }),
    );
    expect(path.basename(command!.command)).toMatch(/^npm(\.cmd)?$/);
    expect(command!.args).toEqual(["run", PREPARE_SCRIPT]);
  });

  it("asks for nothing when a plugin declares no step", () => {
    expect(pluginPrepareCommand(pluginDir())).toBeNull();
    expect(
      pluginPrepareCommand(pluginDir({ build: "termix-plugin build" })),
    ).toBeNull();
    expect(
      pluginPrepareCommand(path.join(os.tmpdir(), "plugin-build-absent")),
    ).toBeNull();
  });

  it("holds rdp-direct to declaring its worker step", () => {
    // The guard is only worth anything while the plugin it was written for
    // still needs it.
    const pkg = JSON.parse(
      fs.readFileSync(
        path.join(import.meta.dirname, "../plugins/rdp-direct/package.json"),
        "utf8",
      ),
    );
    expect(pkg.scripts[PREPARE_SCRIPT]).toContain("build-worker.mjs");
    expect(
      pluginPrepareCommand(
        path.join(import.meta.dirname, "../plugins/rdp-direct"),
      ),
    ).not.toBeNull();
  });

  it("keeps the declared build runnable by hand too", () => {
    // Someone in the plugin directory types `npm run build` and expects both
    // halves, even though this script never takes that path.
    const pkg = JSON.parse(
      fs.readFileSync(
        path.join(import.meta.dirname, "../plugins/rdp-direct/package.json"),
        "utf8",
      ),
    );
    expect(pkg.scripts.build).toContain(PREPARE_SCRIPT);
    expect(pkg.scripts.build).toContain("termix-plugin build");
  });
});
