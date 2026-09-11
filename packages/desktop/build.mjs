/**
 * Bundle the main process and the preload into two CJS files.
 *
 * Why a bundler at all, when every other package here is happy with `tsc`:
 *
 * - **CJS cannot `require()` ESM.** `packages/desktop` is CommonJS because
 *   Electron's ESM main process has real `__dirname` and preload caveats, and
 *   `@cuesheet/daemon` is ESM. Bundling the daemon *into* the main process
 *   sidesteps the boundary instead of arguing with it.
 * - **asar has no `node_modules` resolution worth relying on.** One file with
 *   everything in it is one fewer packaging failure in Step 25.
 * - **A sandboxed preload has no `require`.** It has to arrive as a single
 *   self-contained script, which is a bundler's job by definition.
 *
 * The daemon is consumed from its built `dist`, not its TypeScript, so the
 * workspace build order (core → harness → daemon → desktop) matters. npm
 * derives it from the dependency graph in each `package.json`.
 */
import { build } from "esbuild";
// Imported rather than assumed global: this file is ESM, and eslint treats a
// bare `process` in a plain .mjs as undefined — correctly.
import process from "node:process";

const dev = process.argv.includes("--dev");

/** @type {import("esbuild").BuildOptions} */
const shared = {
  bundle: true,
  platform: "node",
  // The workspace's floor is Node 22 and Electron's bundled Node is newer
  // still, so this only stops esbuild downlevelling syntax both runtimes
  // already have.
  target: "node22",
  format: "cjs",
  sourcemap: true,
  minify: !dev,
  logLevel: "info",
  external: [
    // Provided by the runtime, never bundled.
    "electron",
    // `ws` optionally requires these two native speedups and falls back to
    // pure JS when they are absent. Bundling them means a native module in an
    // asar — the single most reliable way to kill a Windows build.
    "bufferutil",
    "utf-8-validate",
  ],
};

await build({
  ...shared,
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.cjs",
});

await build({
  ...shared,
  entryPoints: ["src/preload.ts"],
  outfile: "dist/preload.cjs",
});
