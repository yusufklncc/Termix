/**
 * Stages the plugins listed in docker/bundled-plugins.json in dist/plugins.
 *
 * getBundledPluginsDir() in src/backend/plugins/paths.ts resolves
 * dist/backend/backend/plugins -> dist/plugins, which is where this writes.
 * A workspace plugin is built from plugins/<id>; a tmxplug plugin is
 * downloaded (or read from a path), checked against its pinned sha256 and
 * unpacked. Either way only what a server needs at runtime lands there.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  loadBundledPlugins,
  fetchArtifact,
  extractArtifact,
} = require("./lib/bundled-plugins.cjs");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "plugins");
const destination = path.join(root, "dist", "plugins");
const cli = path.join(root, "packages", "plugin-sdk", "cli", "index.mjs");

/** What a plugin declares when its build is nothing but the CLI call. */
const PLAIN_BUILD = "termix-plugin build";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

// Same list as a .tmxplug, see packages/plugin-sdk/cli/lib/tmxplug.mjs.
const SHIPPED = [
  "manifest.json",
  "dist",
  "locales",
  "migrations",
  "README.md",
  "CHANGELOG.md",
  "icon.svg",
];

/**
 * How to build one workspace plugin.
 *
 * A plugin that declares a build of its own gets its own build run. Nearly
 * all of them declare exactly the CLI call, which is invoked directly to save
 * an npm start-up each. rdp-direct declares a step before it -- esbuild
 * writing its decoder worker -- and that worker is gitignored. Calling the
 * CLI straight past the declaration therefore built fine on a machine that
 * happened to have the file lying about from an earlier run, and failed on a
 * clean checkout, which is where CI found it.
 */
function pluginBuildCommand(pluginDir) {
  const packageJson = path.join(pluginDir, "package.json");
  const declared = fs.existsSync(packageJson)
    ? (JSON.parse(fs.readFileSync(packageJson, "utf8")).scripts ?? {}).build
    : undefined;

  return declared && declared !== PLAIN_BUILD
    ? { command: npm, args: ["run", "build"] }
    : { command: process.execPath, args: [cli, "build"] };
}

function stageWorkspace(id) {
  const pluginDir = path.join(source, id);

  const { command, args } = pluginBuildCommand(pluginDir);
  execFileSync(command, args, { cwd: pluginDir, stdio: "inherit" });

  if (!fs.existsSync(path.join(pluginDir, "dist", "backend.js"))) {
    throw new Error(`${id} produced no dist/backend.js`);
  }

  const outDir = path.join(destination, id);
  fs.mkdirSync(outDir, { recursive: true });
  for (const entry of SHIPPED) {
    const from = path.join(pluginDir, entry);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(outDir, entry), { recursive: true });
  }
}

async function main() {
  const plugins = loadBundledPlugins(root);

  fs.rmSync(destination, { recursive: true, force: true });

  for (const plugin of plugins) {
    if (plugin.source === "workspace") {
      stageWorkspace(plugin.id);
    } else {
      const buffer = await fetchArtifact(plugin, root);
      await extractArtifact(
        buffer,
        path.join(destination, plugin.id),
        plugin.id,
      );
      console.log(`unpacked ${plugin.id}`);
    }
  }

  console.log(
    `Bundled ${plugins.length} plugin(s): ${plugins.map((p) => p.id).join(", ")}`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.message ?? error);
    process.exit(1);
  });
}

module.exports = { pluginBuildCommand, PLAIN_BUILD };
