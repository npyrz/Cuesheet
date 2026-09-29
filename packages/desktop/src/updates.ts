import type { AppUpdater } from "electron-updater";
import type { UpdateService, UpdateStatus } from "@cuesheet/daemon";

type Updater = Pick<
  AppUpdater,
  | "autoDownload"
  | "autoInstallOnAppQuit"
  | "allowPrerelease"
  | "allowDowngrade"
  | "on"
  | "checkForUpdates"
  | "downloadUpdate"
  | "quitAndInstall"
>;

export interface DesktopUpdates extends UpdateService {
  installRequested(): boolean;
  finishInstall(close: () => Promise<void>): Promise<void>;
}

export function createDesktopUpdates(
  updater: Updater,
  options: {
    version: string;
    restart: () => void;
    changed: (status: UpdateStatus) => void;
  },
): DesktopUpdates {
  let state: UpdateStatus = { phase: "idle", currentVersion: options.version };
  let checking: Promise<void> | undefined;
  let installing: Promise<void> | undefined;
  const set = (next: Omit<UpdateStatus, "currentVersion">) => {
    state = { currentVersion: options.version, ...next };
    options.changed({ ...state });
  };
  const fail = (error: unknown) =>
    set({
      phase: "error",
      message: error instanceof Error ? error.message : String(error),
    });

  // Prerelease detection defaults to the app's version. Our source maturity
  // suffix is independent of the GitHub channel: only main's Latest is a feed.
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.on("error", fail);
  updater.on("download-progress", (progress: { percent: number }) => {
    if (state.phase === "downloading") {
      set({ ...state, percent: Math.max(0, Math.min(100, progress.percent)) });
    }
  });
  updater.on("update-downloaded", (info: { version: string }) => {
    set({ phase: "ready", version: info.version });
  });

  return {
    status: () => ({ ...state }),
    check() {
      if (checking) return checking;
      if (state.phase === "ready" || state.phase === "installing")
        return Promise.resolve();
      set({ phase: "checking" });
      checking = (async () => {
        try {
          const result = await updater.checkForUpdates();
          if (!result?.isUpdateAvailable) {
            set({ phase: "idle" });
            return;
          }
          set({
            phase: "downloading",
            version: result.updateInfo.version,
            percent: 0,
          });
          await updater.downloadUpdate();
        } catch (error) {
          fail(error);
        }
      })().finally(() => {
        checking = undefined;
      });
      return checking;
    },
    prepareInstall() {
      if (state.phase !== "ready")
        throw new Error("No verified update is ready to install.");
      set({ ...state, phase: "installing" });
    },
    restart: options.restart,
    installRequested: () => state.phase === "installing",
    finishInstall(close) {
      if (installing) return installing;
      if (state.phase !== "installing")
        return Promise.reject(new Error("Installation was not requested."));
      installing = (async () => {
        try {
          // quitAndInstall starts the Windows installer before emitting quit.
          // Waiting in before-quit *after* that call is already too late.
          await close();
          updater.quitAndInstall(false, true);
        } catch (error) {
          fail(error);
          throw error;
        }
      })();
      return installing;
    },
  };
}
