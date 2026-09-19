import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** Where the daemon listens. Mirrors `DEFAULT_PORT` in `@cuesheet/core`. */
const DAEMON = "127.0.0.1:7373";

export default defineConfig({
  plugins: [react()],

  /**
   * Relative asset paths.
   *
   * Step 21 loads this build from `file://` inside Electron, where an
   * absolute `/assets/index.js` resolves to the filesystem root and the window
   * comes up blank with no error worth reading. Setting it now costs nothing;
   * discovering it during packaging costs an afternoon.
   */
  base: "./",

  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // The daemon registers every route twice — at the root and under
      // `/api` — precisely so this proxy is one line instead of a rewrite.
      // `ws: true` because the event socket moved under this prefix in Step
      // 32: it is `/api/projects/:id/ws` now, so one rule forwards both the
      // HTTP calls and the upgrade. The separate `/ws` entry that used to sit
      // here is gone with the route it proxied.
      "/api": { target: `http://${DAEMON}`, changeOrigin: true, ws: true },
    },
  },

  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Sourcemaps in an alpha the user is expected to file bugs against.
    sourcemap: true,
  },
});
