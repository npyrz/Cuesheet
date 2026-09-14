/**
 * The bridge, and the whole of it.
 *
 * `contextIsolation` is on and `nodeIntegration` is off, so the renderer gets
 * exactly the three members `CuesheetBridge` in `packages/ui/src/api/base.ts`
 * declares and nothing else. That interface is the contract — the UI was
 * written against it in Phase 4, before this file existed, and it is the
 * reason the Desk needs no Electron-shaped branches.
 *
 * Everything else the Desk does goes over HTTP to the daemon, which is the
 * point: the phone in M3 gets the same app with no bridge at all.
 */
import { contextBridge, ipcRenderer } from "electron";
import { CHOOSE_DIRECTORY_CHANNEL, parseDaemonPort } from "./launch.js";

const daemonPort = parseDaemonPort(process.argv);

contextBridge.exposeInMainWorld("cuesheet", {
  // `process.platform` from the shell, so `⌘` vs `Ctrl` is decided by the OS
  // rather than guessed from a deprecated `navigator.platform`.
  platform: process.platform,
  ...(daemonPort === undefined ? {} : { daemonPort }),
  chooseDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke(CHOOSE_DIRECTORY_CHANNEL) as Promise<string | null>,
});
