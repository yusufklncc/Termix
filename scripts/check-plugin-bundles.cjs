/**
 * Every built plugin bundle, against the SDK surface it will link to.
 *
 * This is the only check that sees what the browser sees. A plugin bundle
 * keeps `import { x } from "@termix-ssh/plugin-sdk/ui"` as a real import --
 * the app resolves it at runtime -- so a name the module no longer exports is
 * not a build error anywhere. It is a link error in the browser, and the
 * plugin's whole frontend silently does not run: the backend activates, the
 * Plugins page says Running, and every tab, host action and panel the module
 * would have contributed is simply absent.
 *
 * That shipped once. ssh-terminal, frozen against the 2.9.2 SDK, imported
 * useConfirmation after 26.10 renamed it to useConfirm; clicking a host did
 * nothing at all, and every check in CI was green.
 *
 * check-plugin-types.cjs covers the plugins built from this tree. This covers
 * the rest as well -- upstream's are downloaded already built, so no
 * type-check of ours ever looks at them.
 */

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

/** Which module each specifier is served from when the app runs. */
const SURFACE = {
  "@termix-ssh/plugin-sdk/ui": "src/ui/plugin-host/sdk-ui.ts",
  "@termix-ssh/plugin-sdk/frontend": "packages/plugin-sdk/src/frontend.ts",
};

const IMPORT =
  /import\s*\{([^}]*)\}\s*from\s*"(@termix-ssh\/plugin-sdk\/[a-z-]+)"/gs;
const DECLARED =
  /export\s+(?:async\s+)?(?:function|const|class|let|var)\s+([A-Za-z_$][\w$]*)/g;
const LISTED = /export\s+(?:type\s+)?\{([^}]*)\}/gs;
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

/**
 * What that module offers.
 *
 * The declared and re-exported names, plus every identifier in the file: a
 * name this parser does not understand is better treated as present than
 * reported as missing, since a false alarm here fails the build.
 */
function surfaceOf(file) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const names = new Set();
  for (const match of source.matchAll(DECLARED)) names.add(match[1]);
  for (const match of source.matchAll(LISTED)) {
    for (const part of match[1].split(",")) {
      const name = part.trim().split(" as ").pop()?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  for (const match of source.matchAll(IDENTIFIER)) names.add(match[0]);
  return names;
}

function bundles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      id: entry.name,
      file: path.join(dir, entry.name, "dist", "frontend.js"),
    }))
    .filter((plugin) => fs.existsSync(plugin.file));
}

/** Names the bundle imports from the SDK that the surface does not offer. */
function missingNames(source, surfaces) {
  const missing = new Set();
  for (const match of source.matchAll(IMPORT)) {
    const surface = surfaces[match[2]];
    if (!surface) continue;
    for (const part of match[1].split(",")) {
      const name = part.trim().split(" as ")[0].trim();
      if (name && !surface.has(name)) {
        missing.add(`${match[2].split("/").pop()}:${name}`);
      }
    }
  }
  return [...missing].sort();
}

function main() {
  const dir = path.join(root, "dist", "plugins");
  const built = bundles(dir);
  if (built.length === 0) {
    console.error(
      "no built plugin bundles in dist/plugins -- run npm run build:plugins first",
    );
    process.exit(1);
  }

  const surfaces = {};
  for (const [specifier, file] of Object.entries(SURFACE)) {
    surfaces[specifier] = surfaceOf(file);
  }

  const broken = [];
  for (const plugin of built) {
    const missing = missingNames(
      fs.readFileSync(plugin.file, "utf8"),
      surfaces,
    );
    if (missing.length > 0) broken.push({ id: plugin.id, missing });
  }

  if (broken.length > 0) {
    console.error("\nplugin bundles import names the app does not export:");
    for (const plugin of broken) {
      console.error(`  ${plugin.id}: ${plugin.missing.join(", ")}`);
    }
    console.error(
      "\nThese fail in the browser, not here: the plugin loads, says Running, and contributes nothing.",
    );
    process.exit(1);
  }
  console.log(`plugin bundles ok (${built.length} bundle(s))`);
}

if (require.main === module) main();

module.exports = { bundles, missingNames, surfaceOf, SURFACE };
