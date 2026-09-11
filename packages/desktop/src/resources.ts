/**
 * Where the files that ship beside the app live — main-process only, because
 * it touches paths.
 *
 * Injectable `path` for the same reason `paths.ts` in core takes one: the
 * Windows answer has to be assertable from a Mac, and mocking
 * `process.platform` does not rebind an ambient `path` module.
 */
import nodePath from "node:path";

export interface UiEntryHost {
  /** `app.isPackaged`. */
  packaged: boolean;
  /** `__dirname` of the bundled main process — `packages/desktop/dist`. */
  dirname: string;
  /** `process.resourcesPath`, which only means anything in a packaged app. */
  resourcesPath?: string | undefined;
  path?: nodePath.PlatformPath;
}

/**
 * Every place `index.html` could be, best first.
 *
 * A list rather than an answer, because the two layouts are decided in
 * different steps: from a checkout the UI is a sibling package, and inside a
 * packaged app it is wherever Step 25's `electron-builder` config puts it.
 * Candidates let that step move the packaged layout without making this
 * function wrong, and let the caller name every path it tried when none of
 * them exist — the difference between a blank window and a sentence telling
 * you to build the UI.
 */
export function uiIndexCandidates(host: UiEntryHost): string[] {
  const path = host.path ?? nodePath;
  const candidates: string[] = [];

  if (host.packaged && host.resourcesPath !== undefined) {
    candidates.push(path.join(host.resourcesPath, "ui", "index.html"));
  }
  // Packaged beside the bundle, inside the asar. Step 25 picks one of these
  // two and the other stays a harmless miss.
  candidates.push(path.join(host.dirname, "ui", "index.html"));
  // From a checkout: packages/desktop/dist → packages/ui/dist. Gated on
  // *not* packaged, symmetrically with the resources path above: inside an
  // asar this resolves to `app.asar/../../ui/dist/index.html`, and asar path
  // handling is strange enough that "it cannot possibly exist" is not worth
  // betting a packaged build on. If it ever did exist, the app would silently
  // serve some checkout's Desk instead of its own.
  if (!host.packaged) {
    candidates.push(
      path.join(host.dirname, "..", "..", "ui", "dist", "index.html"),
    );
  }

  return candidates;
}

/**
 * The tray icon for this platform.
 *
 * macOS wants a **template** image: black plus alpha, which the OS recolours
 * for a light menu bar, a dark one, and the highlighted state. Windows wants
 * an `.ico`, because a PNG resamples badly at the DPI scales a Windows
 * taskbar actually uses. Shipping both and choosing here is the whole of it.
 *
 * `@2x` is not named: macOS picks the retina variant itself as long as it
 * sits beside the 1x file, which is why the generator writes both.
 */
export function trayIconName(platform: string): string {
  return platform === "win32" ? "tray.ico" : "iconTemplate.png";
}

/**
 * Where a file from `assets/` could be, best first.
 *
 * These travel as `extraResources` rather than inside the asar: reading an
 * image out of an archive works, mostly, and "mostly" is not a thing to
 * discover from a bug report about a missing tray icon.
 */
export function assetCandidates(host: UiEntryHost, file: string): string[] {
  const path = host.path ?? nodePath;
  const candidates: string[] = [];

  if (host.packaged && host.resourcesPath !== undefined) {
    candidates.push(path.join(host.resourcesPath, "assets", file));
  }
  if (!host.packaged) {
    // From a checkout: packages/desktop/dist → packages/desktop/assets.
    candidates.push(path.join(host.dirname, "..", "assets", file));
  }

  return candidates;
}
