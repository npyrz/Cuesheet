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
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  shell,
  Tray,
} from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { EventBus } from "@cuesheet/daemon";
import {
  ACTIVE_PROJECT_CHANNEL,
  bridgeArguments,
  CHOOSE_DIRECTORY_CHANNEL,
  devServerUrl,
} from "./launch.js";
import {
  parseActiveProject,
  trayProjectLabel,
  trayTooltip,
  windowTitle,
  type ActiveProject,
} from "./project.js";
import {
  assetCandidates,
  trayIconName,
  uiIndexCandidates,
} from "./resources.js";
import { summarise } from "./summary.js";

/**
 * The app's identity, and it must equal `appId` in `electron-builder.yml`.
 *
 * Windows routes notifications through the AppUserModelID and silently drops
 * every `new Notification()` from a process that has not set one — no error,
 * no warning, just nothing on screen. Set at module scope so it is in place
 * before anything can try to notify, and written down in exactly two files so
 * a mismatch is a one-line diff rather than an afternoon.
 */
const APP_ID = "io.github.npyrz.cuesheet";

/** How long a clean shutdown gets before the app quits regardless. */
const SHUTDOWN_TIMEOUT_MS = 5_000;
app.setAppUserModelId(APP_ID);

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
  /**
   * The in-process event stream, when this daemon is ours.
   *
   * `null` for an attached daemon: its events exist in another process, and
   * the honest options there are a WebSocket client or nothing. Nothing, for
   * now — notifications from an attached daemon are a dev-loop nicety, and
   * the window itself is already subscribed over `/ws`.
   */
  bus: EventBus | null;
  close(): Promise<void>;
}

let daemon: DaemonConnection | null = null;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

/**
 * The project the Desk says it is showing, or `null` for the launch surface.
 *
 * Module scope rather than a closure, because `refreshTrayMenu` rebuilds the
 * menu from nothing every time it runs — including from the "Start at login"
 * click handler. A project held anywhere narrower would vanish from the menu
 * the first time somebody toggled an unrelated checkbox.
 */
let activeProject: ActiveProject | null = null;

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
      bus: handle.bus,
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
      bus: null,
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
    // A window recreated from the tray while a project is open must come back
    // titled. The renderer re-announces on load anyway, but not before the
    // window has been on screen for a beat under the wrong name.
    title: windowTitle(activeProject),
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

  // Close-to-tray on Windows, where closing a window is not expected to end
  // the app — but only while there is a tray to get it back from. Without
  // that guard a missing icon leaves a running app with no window and no way
  // to reach it, which is the worst outcome of the three.
  window.on("close", (event) => {
    if (quitting || process.platform !== "win32" || tray === null) return;
    event.preventDefault();
    window.hide();
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

/**
 * The tray, and the menu behind it.
 *
 * Built once the daemon is up, because the menu reports the port it bound —
 * which is the fastest way to answer "is the thing even running" without
 * opening a window.
 */
function createTray(port: number): void {
  const file = assetCandidates(
    {
      packaged: app.isPackaged,
      dirname: __dirname,
      resourcesPath: process.resourcesPath,
    },
    trayIconName(process.platform),
  ).find((candidate) => existsSync(candidate));

  if (file === undefined) {
    // Not fatal, but it changes what quitting means on Windows, so it is not
    // swallowed either — `window-all-closed` checks for a tray before it
    // decides to keep the app alive with no window.
    console.error("[cuesheet] no tray icon found; continuing without a tray.");
    return;
  }

  const image = nativeImage.createFromPath(file);
  // The bit that makes a macOS menu bar icon look native rather than pasted
  // on: the OS inverts a template image for dark menu bars and for the
  // highlighted state.
  if (process.platform === "darwin") image.setTemplateImage(true);

  tray = new Tray(image);
  tray.setToolTip(trayTooltip(activeProject, port));
  refreshTrayMenu(port);

  // Windows convention: a left click opens the app. macOS opens the menu on
  // either button, so binding a click there would fight the platform.
  if (process.platform === "win32") {
    tray.on("click", showWindow);
  }
}

function refreshTrayMenu(port: number): void {
  if (tray === null) return;

  // The OS is the store for this preference — `getLoginItemSettings` reads
  // the real registry key or login item, so there is no preferences file to
  // write, migrate, or get out of step with what the system actually does.
  const openAtLogin = app.getLoginItemSettings().openAtLogin;

  tray.setContextMenu(
    Menu.buildFromTemplate([
      // The project first and the daemon under it: which project this is is
      // the question the tray could not answer before Step 41, and the port
      // is the one it already could.
      { label: trayProjectLabel(activeProject), enabled: false },
      { label: `Daemon on 127.0.0.1:${port}`, enabled: false },
      { type: "separator" },
      { label: "Open the Desk", click: showWindow },
      {
        label: "Hide",
        click: () => mainWindow?.hide(),
        enabled: mainWindow !== null && mainWindow.isVisible(),
      },
      { type: "separator" },
      {
        label: "Start at login",
        type: "checkbox",
        checked: openAtLogin,
        click: (item) => {
          app.setLoginItemSettings({ openAtLogin: item.checked });
          refreshTrayMenu(port);
        },
      },
      { type: "separator" },
      { label: "Quit Cuesheet", click: () => app.quit() },
    ]),
  );
}

function showWindow(): void {
  if (mainWindow === null) {
    if (daemon !== null) void createWindow(daemon.port);
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * Tell the user what happened while they were looking at something else.
 *
 * Deliberately quiet when the Desk is in front of them: a run finishing is
 * already visible on the tile, and a notification for it is noise that
 * teaches people to dismiss notifications without reading them — which is
 * exactly the habit a standby must not run into.
 */
function watchForNotifications(bus: EventBus): void {
  if (!Notification.isSupported()) return;

  bus.attach((event) => {
    if (event.t === "done") {
      notify("Run finished", summarise(event.result));
    } else if (event.t === "error") {
      notify("Run failed", event.message);
    } else if (event.t === "standby") {
      // The one that is genuinely waiting on a human. Nothing moves until
      // this is answered, so it interrupts even a focused window.
      notify("Waiting on you", event.ask, { force: true });
    }
  });
}

function notify(
  title: string,
  body: string,
  options: { force?: boolean } = {},
): void {
  const focused =
    mainWindow !== null && mainWindow.isVisible() && mainWindow.isFocused();
  if (focused && options.force !== true) return;

  const notification = new Notification({ title, body });
  notification.on("click", showWindow);
  notification.show();
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
  ipcMain.on(ACTIVE_PROJECT_CHANNEL, (_event, payload: unknown) => {
    setActiveProject(parseActiveProject(payload));
  });
  createTray(daemon.port);
  if (daemon.bus !== null) watchForNotifications(daemon.bus);
  await createWindow(daemon.port);
}

/**
 * The Desk has switched projects — or gone back to the launch surface, which
 * is the same message with `null` in it.
 *
 * **A switch is not a stop** (Step 34), and neither is going back to the list:
 * the daemon's queues and runs belong to its runtimes, not to this window. So
 * everything this does is cosmetic by design — a title and a tray label — and
 * nothing here touches the daemon.
 */
function setActiveProject(project: ActiveProject | null): void {
  activeProject = project;
  mainWindow?.setTitle(windowTitle(project));
  if (daemon !== null) {
    tray?.setToolTip(trayTooltip(project, daemon.port));
    refreshTrayMenu(daemon.port);
  }
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
  app.on("second-instance", showWindow);

  app.on("window-all-closed", () => {
    // Three platforms, one rule: the app outlives its window when there is
    // somewhere to get it back from. macOS has the dock, and a tray is the
    // same promise everywhere else — a daemon that keeps running standbys
    // and streams is the point of the app, not an accident of it.
    //
    // With no tray, the window *was* the app, so closing it quits.
    if (process.platform === "darwin" || tray !== null) return;
    app.quit();
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
  /**
   * The shutdown path, and the promise behind it: no orphaned processes, no
   * run left `running` forever, no stale lockfile pointing at a dead port.
   *
   * `handle.close()` is what does the work — it stops the queue, aborts the
   * active run (which takes its subprocess tree with it), marks that run and
   * every queued one `interrupted`, flushes the store, and removes
   * `daemon.json`. Quitting without it is what leaves the next boot probing a
   * port nobody is on.
   *
   * The half this cannot cover is a force-quit, where no handler runs at all.
   * That is why `reconcileInterruptedRuns` exists in the daemon: the next
   * boot repairs what a kill left behind.
   */
  app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;

    // Never leave a tray icon behind on Windows, where a ghost lingers until
    // the user mouses over it.
    tray?.destroy();
    tray = null;

    if (daemon === null || !daemon.owned) return;

    event.preventDefault();
    const connection = daemon;

    // A close that hangs must not become an app that cannot be quit. Five
    // seconds is far longer than a clean shutdown takes and far shorter than
    // a person's patience with a window that will not go away.
    const deadline = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), SHUTDOWN_TIMEOUT_MS),
    );

    void Promise.race([connection.close(), deadline])
      .then((outcome) => {
        if (outcome === "timeout") {
          console.error(
            `[cuesheet] daemon did not shut down within ${SHUTDOWN_TIMEOUT_MS}ms; quitting anyway.`,
          );
        }
      })
      .catch((error: unknown) => {
        console.error("[cuesheet] unclean daemon shutdown:", error);
      })
      .finally(() => app.quit());
  });

  void boot();
}
