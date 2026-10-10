/**
 * Bundles the H.264 decoder into a file the frontend can import as a URL.
 *
 * The decoder runs on a worker thread, which is not optional: decoding
 * 1080p60 on the main thread competes with rendering it and the picture
 * stutters. Core's Vite build understands `new Worker(new URL("./x.ts", ...))`
 * but a plugin is bundled by esbuild, which does not -- so the worker is
 * built separately and imported with "?url", which the SDK copies next to the
 * bundle and resolves under /plugin-assets/<id>/.
 */
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.join(here, "src/frontend/rdp-decoder.worker.ts")],
  outfile: path.join(here, "src/frontend/generated/rdp-decoder.worker.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "browser",
  minify: true,
  logLevel: "warning",
});
