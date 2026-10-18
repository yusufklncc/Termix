/**
 * Type-checks every plugin in this repo against the SDK it will run on.
 *
 * `tsc -b` at the root covers src/ and the SDK, not plugins/: each plugin has
 * a tsconfig of its own so it keeps building if it ever moves out. Nothing
 * else looks at them either -- esbuild does not type-check, and a plugin's
 * vitest suite only runs the files its tests import.
 *
 * That gap cost a release. ssh-terminal is carried here with local patches
 * and was frozen at the 2.9.2 SDK; 26.10 renamed useConfirmation to
 * useConfirm and dropped ConnectionScreen's retryLabel. The import of a name
 * the module no longer exports does not fail the build -- it fails at link
 * time in the browser, so the backend activated, the Plugins page said
 * Running, and the plugin's entire frontend never ran. The terminal
 * disappeared from the host menu and clicking a host did nothing at all,
 * because the host action that would have opened it was never registered.
 *
 * Every check in CI passed.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "plugins");
const SCRIPT = "typecheck";

function pluginDirs() {
  if (!fs.existsSync(source)) return [];
  return fs
    .readdirSync(source, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(source, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, "tsconfig.json")));
}

/** The plugin's own script, so this never second-guesses its tsconfig. */
function typecheckCommand(dir) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
  return pkg?.scripts?.[SCRIPT]
    ? { command: npm(), args: ["run", SCRIPT] }
    : null;
}

function npm() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function main() {
  const failed = [];
  let checked = 0;

  for (const dir of pluginDirs()) {
    const command = typecheckCommand(dir);
    if (!command) {
      console.log(`${path.basename(dir)}: no "${SCRIPT}" script, skipped`);
      continue;
    }
    const result = spawnSync(command.command, command.args, {
      cwd: dir,
      encoding: "utf8",
      shell: process.platform === "win32",
      maxBuffer: 64 * 1024 * 1024,
    });
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    if (result.status !== 0) failed.push(path.basename(dir));
    checked += 1;
  }

  if (failed.length > 0) {
    console.error(`\nplugin type-check failed: ${failed.join(", ")}`);
    process.exit(1);
  }
  console.log(`plugin types ok (${checked} plugin(s))`);
}

if (require.main === module) main();

module.exports = { pluginDirs, typecheckCommand, SCRIPT };
