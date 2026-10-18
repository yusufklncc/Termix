/**
 * The only check that sees what the browser sees.
 *
 * A plugin bundle keeps its SDK imports as real imports -- the app resolves
 * them at runtime -- so importing a name the module no longer exports is not
 * a build error anywhere. It is a link error in the browser, and the plugin's
 * whole frontend silently does not run: the backend activates, the Plugins
 * page says Running, and every tab, host action and panel it would have
 * contributed is absent. ssh-terminal shipped that way, and clicking a host
 * did nothing at all.
 *
 * check-plugin-types.cjs covers the plugins built from this tree. This covers
 * upstream's too, which arrive already built and are type-checked by nobody.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { bundles, missingNames, surfaceOf, SURFACE } =
  require("./check-plugin-bundles.cjs") as {
    bundles: (dir: string) => Array<{ id: string; file: string }>;
    missingNames: (
      source: string,
      surfaces: Record<string, Set<string>>,
    ) => string[];
    surfaceOf: (file: string) => Set<string>;
    SURFACE: Record<string, string>;
  };

const UI = "@termix-ssh/plugin-sdk/ui";
const FE = "@termix-ssh/plugin-sdk/frontend";

function surfaces(): Record<string, Set<string>> {
  return Object.fromEntries(
    Object.entries(SURFACE).map(([specifier, file]) => [
      specifier,
      surfaceOf(file),
    ]),
  );
}

describe("what the app offers plugins", () => {
  it("is read from the modules the app actually serves", () => {
    const ui = surfaceOf(SURFACE[UI]);
    const frontend = surfaceOf(SURFACE[FE]);
    // The two that were in play: one is there now, one never was.
    expect(ui.has("useConfirm")).toBe(true);
    expect(ui.has("useConfirmation")).toBe(false);
    expect(frontend.has("usePluginApi")).toBe(true);
  });
});

describe("the names a bundle imports", () => {
  it("names the one the app does not export", () => {
    const source = `import { Button, useConfirmation } from "${UI}";`;
    expect(missingNames(source, surfaces())).toEqual(["ui:useConfirmation"]);
  });

  it("says nothing when every name is there", () => {
    const source = `import { Button, useConfirm } from "${UI}";
import { usePluginApi } from "${FE}";`;
    expect(missingNames(source, surfaces())).toEqual([]);
  });

  it("reads through a renaming import, which is what esbuild writes", () => {
    const source = `import { isElectron as isElectron2, useConfirmation as c } from "${UI}";`;
    expect(missingNames(source, surfaces())).toEqual(["ui:useConfirmation"]);
  });

  it("leaves specifiers it does not serve alone", () => {
    const source = `import { anything } from "@termix-ssh/plugin-sdk/docs";
import { whatever } from "react";`;
    expect(missingNames(source, surfaces())).toEqual([]);
  });
});

describe("which bundles are checked", () => {
  it("is every built plugin's frontend", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bundles-"));
    for (const id of ["one", "two"]) {
      fs.mkdirSync(path.join(dir, id, "dist"), { recursive: true });
      fs.writeFileSync(path.join(dir, id, "dist", "frontend.js"), "");
    }
    // A backend-only plugin has no frontend to link.
    fs.mkdirSync(path.join(dir, "three", "dist"), { recursive: true });
    fs.writeFileSync(path.join(dir, "three", "dist", "backend.js"), "");

    expect(bundles(dir).map((plugin) => plugin.id)).toEqual(["one", "two"]);
    expect(bundles(path.join(dir, "absent"))).toEqual([]);
  });

  it("runs after the plugins are built, where CI will reach it", () => {
    const pkg = JSON.parse(
      fs.readFileSync(
        path.join(import.meta.dirname, "../package.json"),
        "utf8",
      ),
    );
    expect(pkg.scripts.build).toContain("check-plugin-bundles.cjs");
    expect(pkg.scripts.build.indexOf("build:plugins")).toBeLessThan(
      pkg.scripts.build.indexOf("check-plugin-bundles.cjs"),
    );
  });
});
