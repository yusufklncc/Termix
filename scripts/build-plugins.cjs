/**
 * Stages the plugins listed in docker/bundled-plugins.json in dist/plugins.
 *
 * getBundledPluginsDir() in src/backend/plugins/paths.ts resolves
 * dist/backend/backend/plugins -> dist/plugins, which is where this writes.
 * Each .tmxplug is downloaded (or read from a path), checked against its
 * pinned sha256 and unpacked.
 *
 * This fork keeps its own plugins in plugins/<id> and lists them with
 * `"source": "workspace"`. Those are built here with this checkout's SDK and
 * staged in place of a download -- three are this fork's own, and two are
 * upstream plugins it patches, which have to be built rather than fetched or
 * the patches are not in what ships.
 *
 * For development, `--local <dir>` (or TERMIX_LOCAL_PLUGINS) points at a
 * folder of plugin repos like ../Plugins. A plugin there whose sources
 * changed since its last build is rebuilt first with this checkout's SDK, so
 * SDK edits apply without publishing, then any built one (has
 * dist/) is copied in place of its pin, or added when it has no pin.
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  loadBundledPlugins,
  fetchArtifact,
  extractArtifact,
  findLocalPluginBuilds,
  rebuildLocalPlugins,
  localSdkBuildCommand,
  copyLocalBuild,
  buildBundledIndex,
} = require("./lib/bundled-plugins.cjs");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "plugins");
const destination = path.join(root, "dist", "plugins");
const cli = path.join(root, "packages", "plugin-sdk", "cli", "index.mjs");

/** A plugin's own step, run before the CLI builds it. */
const PREPARE_SCRIPT = "build:prepare";
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
 * The step a plugin needs before the CLI can build it, if it declares one.
 *
 * rdp-direct writes its decoder worker with esbuild, and that file is
 * gitignored, so skipping the step built fine on a machine that still had the
 * worker from an earlier run and failed on a clean checkout.
 *
 * It is a script of its own rather than something parsed out of `build`, and
 * the CLI below is still invoked by path. Running `npm run build` instead
 * looked tidier and broke the image: that resolves `termix-plugin` through
 * node_modules/.bin, which does not exist in the Docker stage that installs
 * dependencies before the SDK's sources are copied in.
 */
function pluginPrepareCommand(pluginDir) {
  const packageJson = path.join(pluginDir, "package.json");
  if (!fs.existsSync(packageJson)) return null;
  const scripts =
    JSON.parse(fs.readFileSync(packageJson, "utf8")).scripts ?? {};
  if (!scripts[PREPARE_SCRIPT]) return null;
  return { command: npm, args: ["run", PREPARE_SCRIPT] };
}

/** Builds plugins/<id> with this checkout's SDK and stages what a server needs. */
function stageWorkspace(id) {
  const pluginDir = path.join(source, id);

  const prepare = pluginPrepareCommand(pluginDir);
  if (prepare) {
    execFileSync(prepare.command, prepare.args, {
      cwd: pluginDir,
      stdio: "inherit",
    });
  }

  execFileSync(process.execPath, [cli, "build"], {
    cwd: pluginDir,
    stdio: "inherit",
  });

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
  const flag = process.argv.indexOf("--local");
  const localArg =
    flag !== -1 ? process.argv[flag + 1] : process.env.TERMIX_LOCAL_PLUGINS;
  const localDir = localArg ? path.resolve(root, localArg) : null;
  const [node, buildArgs] = localSdkBuildCommand();
  rebuildLocalPlugins(localDir, null, (repo, id) => {
    console.log(`building ${id}`);
    execFileSync(node, buildArgs, { cwd: repo, stdio: "inherit" });
  });
  const local = findLocalPluginBuilds(localDir);

  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });

  for (const plugin of plugins) {
    if (plugin.source === "workspace") {
      stageWorkspace(plugin.id);
      console.log(`built ${plugin.id}`);
      continue;
    }
    const repo = local.get(plugin.id);
    if (repo) {
      copyLocalBuild(repo, path.join(destination, plugin.id));
      console.log(`copied local build of ${plugin.id}`);
      continue;
    }
    const buffer = await fetchArtifact(plugin, root);
    await extractArtifact(buffer, path.join(destination, plugin.id), plugin.id);
    console.log(`unpacked ${plugin.id}`);
  }

  // A local plugin with no pin yet still gets staged, so new plugins work too.
  const pinned = new Set(plugins.map((p) => p.id));
  const extra = [...local.keys()].filter((id) => !pinned.has(id));
  for (const id of extra) {
    copyLocalBuild(local.get(id), path.join(destination, id));
    console.log(`copied local build of ${id} (not pinned)`);
  }

  const staged = [...pinned, ...extra];
  fs.writeFileSync(
    path.join(destination, "bundled-index.json"),
    `${JSON.stringify(buildBundledIndex(plugins, staged), null, 2)}
`,
  );

  console.log(
    `Bundled ${plugins.length + extra.length} plugin(s): ${[...pinned, ...extra].join(", ")}`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.message ?? error);
    process.exit(1);
  });
}

module.exports = { pluginPrepareCommand, PREPARE_SCRIPT };
