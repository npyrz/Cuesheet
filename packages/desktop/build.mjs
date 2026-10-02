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
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

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
  define: {
    CUESHEET_UPDATES_ENABLED: JSON.stringify(
      process.env.CUESHEET_SIGNED_RELEASE === "true" &&
        process.env.GITHUB_REF_NAME === "main",
    ),
  },
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
  // A real `import.meta.url` — this bundle's own file URL — because a CJS
  // bundle otherwise gets an empty `import.meta`, and Step 59 found what
  // that costs: `web-tree-sitter`'s ESM build calls
  // `createRequire(import.meta.url)` while initialising, so the bundled
  // daemon threw on its first repo map and the packaged app quietly had
  // none. It was caught by bundling a probe with these exact settings and
  // running it, not by any of the five checks.
  //
  // Main only. The preload is sandboxed and has no `require`, so this
  // banner would break it — and nothing in the preload reads `import.meta`.
  define: {
    ...shared.define,
    "import.meta.url": "__cuesheetImportMetaUrl",
  },
  // The directive is repeated here because esbuild puts the banner above its
  // own `"use strict"`, and a directive that is not first is just a string:
  // the whole main process would silently run in sloppy mode.
  banner: {
    js: '"use strict";const __cuesheetImportMetaUrl = require("node:url").pathToFileURL(__filename).href;',
  },
});

await build({
  ...shared,
  entryPoints: ["src/preload.ts"],
  outfile: "dist/preload.cjs",
});

/**
 * The repo map's wasm, beside the bundle — Step 59.
 *
 * Bundled, the daemon cannot find its own `grammars/` or resolve
 * `web-tree-sitter` from `node_modules`: `import.meta.url` is gone, and a
 * packaged app has no `node_modules` worth resolving from. So both are copied
 * to `dist/grammars`, which `src/resources.ts` points the daemon at and
 * `electron-builder.yml` ships as `extraResources`.
 *
 * The runtime is resolved from the daemon's own dependency rather than
 * vendored, because it must match the `web-tree-sitter` JavaScript that
 * esbuild just inlined — byte for byte, version for version.
 */
const here = dirname(fileURLToPath(import.meta.url));
const daemonDir = join(here, "..", "daemon");
const grammarsOut = join(here, "dist", "grammars");
mkdirSync(grammarsOut, { recursive: true });
for (const file of readdirSync(join(daemonDir, "grammars"))) {
  if (file.endsWith(".wasm")) {
    copyFileSync(join(daemonDir, "grammars", file), join(grammarsOut, file));
  }
}
const runtimeWasm = createRequire(join(daemonDir, "package.json")).resolve(
  "web-tree-sitter/web-tree-sitter.wasm",
);
copyFileSync(runtimeWasm, join(grammarsOut, "web-tree-sitter.wasm"));
