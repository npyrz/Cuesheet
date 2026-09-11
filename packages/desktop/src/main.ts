/**
 * Cuesheet's Electron main process.
 *
 * The daemon runs **inside** this process rather than as a spawned sidecar.
 * That is the decision Phase 5 rests on: one Node runtime to ship, one thing
 * to package, and no way to leave an orphaned `cuesheetd` behind when the app
 * dies. `@cuesheet/daemon` exports `startDaemon` as a function for exactly
 * this caller.
 *
 * Two shapes are load-bearing and easy to get backwards:
 *
 * - **CJS importing ESM.** This package has no `"type": "module"` on purpose
 *   (see the Decisions table in PLAN-STEP.MD), and `@cuesheet/daemon` is ESM.
 *   A static `import` of it does not typecheck under `nodenext` and does not
 *   run under Node — so the daemon is reached through `await import()` inside
 *   `app.whenReady()`'s async context. esbuild inlines it when bundling.
 * - **The window is created after the port is known.** `handle.port` is the
 *   *bound* port, and it is the only thing the preload has to tell the
 *   renderer. Creating the window first and pushing the port in later means a
 *   first paint that fetches from nowhere.
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  bridgeArguments,
  CHOOSE_DIRECTORY_CHANNEL,
  devServerUrl,
} from "./launch.js";
import { uiIndexCandidates } from "./ui-entry.js";

/**
 * The daemon this window talks to.
 *
 * `owned` is the whole reason this is a type and not a number. A dev machine
 * routinely has `cuesheetd` already running on 7373, and the honest response
 * to that is to use it — but a daemon we merely attached to is somebody
 * else's process, and quitting the app must not take it down with us.
 */
interface DaemonConnection {
  port: number;
  url: string;
  owned: boolean;
  close(): Promise<void>;
}

let daemon: DaemonConnection | null = null;
let mainWindow: BrowserWindow | null = null;
let quitting = false;

/**
 * Start the daemon, or attach to the one that is already there.
 *
 * `startDaemon` throws `PortInUseError` instead of exiting precisely so this
 * caller can make that choice; the standalone `cuesheetd` prints and stops.
 * Attaching is not a fallback hack — the port is fixed by design so that
 * every client can find the daemon, and the app is a client.
 */
async function connectDaemon(): Promise<DaemonConnection> {
  const { startDaemon, harnessRuntime, PortInUseError, findRunningDaemon } =
    await import("@cuesheet/daemon");

  try {
    // The library's defaults are inert so its own tests stay offline and
    // free. `harnessRuntime()` is where the app opts into real harnesses —
    // the same one line `cuesheetd`'s `main.ts` uses, so the two embedders
    // cannot drift.
    const handle = await startDaemon({ ...harnessRuntime() });
    return {
      port: handle.port,
      url: handle.url,
      owned: true,
      close: () => handle.close(),
    };
  } catch (error) {
    if (!(error instanceof PortInUseError)) throw error;

    const existing = await findRunningDaemon();
    if (existing === null) throw error;

    return {
      port: existing.port,
      url: `http://127.0.0.1:${existing.port}`,
      owned: false,
      close: async () => {
        // Not ours. Leaving it running is the point.
      },
    };
  }
}

async function createWindow(port: number): Promise<void> {
  // Resolved *before* the window exists, because the answer decides what the
  // preload is given: a dev-server page must use the Vite proxy, a `file://`
  // page must use the port. `additionalArguments` is fixed at construction,
  // so learning this afterwards would be too late.
  const source = await resolveUiSource();
  if (source === null) return;

  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    title: "Cuesheet",
    // Painted before the renderer has any CSS, so a dark Desk does not flash
    // white on every launch.
    backgroundColor: "#0d0d0f",
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: bridgeArguments(source.kind, port),
    },
  });

  mainWindow = window;
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    mainWindow = null;
  });

  // A link to the Anthropic docs must not replace the Desk with a web page,
  // and must not open a second Electron window with a preload attached.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:$/.test(new URL(url).protocol)) void shell.openExternal(url);
    return { action: "deny" };
  });

  if (source.kind === "dev-server") {
    await window.loadURL(source.url);
    return;
  }
  await window.loadFile(source.path);
}

type UiSource =
  { kind: "dev-server"; url: string } | { kind: "file"; path: string };

/**
 * The dev server if something is answering there, the built Desk otherwise —
 * so `npm run dev` works whether or not you remembered to start Vite in
 * another terminal.
 *
 * Returns `null` only when neither exists, having already said so in a dialog:
 * it is the one startup failure a person can actually fix, so it names the
 * command instead of leaving a blank window.
 */
async function resolveUiSource(): Promise<UiSource | null> {
  if (!app.isPackaged) {
    const url = devServerUrl();
    try {
      await fetch(url, { signal: AbortSignal.timeout(700) });
      return { kind: "dev-server", url };
    } catch {
      // Not running. Fall through to the built UI.
    }
  }

  const candidates = uiIndexCandidates({
    packaged: app.isPackaged,
    dirname: __dirname,
    resourcesPath: process.resourcesPath,
  });
  const entry = candidates.find((candidate) => existsSync(candidate));
  if (entry !== undefined) return { kind: "file", path: entry };

  dialog.showErrorBox(
    "The Desk has not been built",
    `Cuesheet could not find the Desk's index.html.\n\n` +
      `Run \`npm run build -w packages/ui\`, or start the dev server with ` +
      `\`npm run dev -w packages/ui\` and relaunch.\n\nLooked in:\n` +
      candidates.map((candidate) => `  ${candidate}`).join("\n"),
  );
  return null;
}

function focusWindow(): void {
  if (mainWindow === null) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

async function boot(): Promise<void> {
  try {
    // The daemon's boot and Electron's are independent, so they overlap. On a
    // cold start `whenReady` is the slower of the two; doing them in sequence
    // adds the daemon's boot to every launch for no reason.
    const [connection] = await Promise.all([connectDaemon(), app.whenReady()]);
    daemon = connection;
  } catch (error) {
    await app.whenReady();
    dialog.showErrorBox(
      "Cuesheet could not start",
      error instanceof Error ? error.message : String(error),
    );
    app.exit(1);
    return;
  }

  ipcMain.handle(CHOOSE_DIRECTORY_CHANNEL, chooseDirectory);
  await createWindow(daemon.port);
}

/**
 * The native half of the Add a Station panel.
 *
 * Step 20 built the typed-path version first and left this hole behind it;
 * the panel already calls `bridge()?.chooseDirectory` and shows a Browse
 * button only when it is there. Returning `null` on cancel rather than
 * throwing is what that call site expects.
 */
async function chooseDirectory(): Promise<string | null> {
  const parent = mainWindow;
  const options = {
    title: "Choose a workspace",
    properties: ["openDirectory" as const, "createDirectory" as const],
  };
  const result =
    parent === null
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(parent, options);
  if (result.canceled) return null;
  return result.filePaths[0] ?? null;
}

/**
 * A second launch focuses the first window instead of starting a second
 * daemon. Without the lock, instance two races instance one for port 7373,
 * loses, and — before this file existed — would have had no window to show
 * for it either.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", focusWindow);

  app.on("window-all-closed", () => {
    // macOS keeps the app in the dock; Windows and Linux expect the quit.
    // Step 22 replaces this with close-to-tray.
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && daemon !== null) {
      void createWindow(daemon.port);
    }
  });

  /**
   * First cut of the shutdown path. Step 23 is where this grows the full
   * story — interrupted runs, child process groups, a flushed store — but
   * `handle.close()` already stops the queue, marks in-flight runs
   * `interrupted`, and removes `daemon.json`, so even this version must not
   * be skipped. Quitting without it is what leaves a stale lockfile pointing
   * at a dead port.
   */
  app.on("before-quit", (event) => {
    if (quitting || daemon === null || !daemon.owned) return;
    event.preventDefault();
    quitting = true;
    daemon
      .close()
      .catch((error: unknown) => {
        console.error("Unclean daemon shutdown:", error);
      })
      .finally(() => app.quit());
  });

  void boot();
}
