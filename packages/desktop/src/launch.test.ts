import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  DEFAULT_DEV_SERVER,
  bridgeArguments,
  daemonPortArg,
  devServerUrl,
  parseDaemonPort,
} from "./launch.js";
import {
  assetCandidates,
  trayIconName,
  uiIndexCandidates,
} from "./resources.js";

describe("daemon port hand-off", () => {
  it("round-trips the bound port through argv", () => {
    expect(parseDaemonPort(["electron", daemonPortArg(51234)])).toBe(51234);
  });

  it("ignores the rest of Electron's argv", () => {
    const argv = [
      "/Applications/Cuesheet.app/Contents/MacOS/Cuesheet",
      "--user-data-dir=/tmp/x",
      daemonPortArg(7373),
      "--enable-features=Foo",
    ];
    expect(parseDaemonPort(argv)).toBe(7373);
  });

  it("returns undefined when nothing passed a port", () => {
    // Not a failure: the UI reads a missing port as "same origin", which is
    // the right answer under the dev server and in a plain browser.
    expect(parseDaemonPort(["electron", "--inspect"])).toBeUndefined();
  });

  it("rejects a port that is not a usable port", () => {
    expect(parseDaemonPort(["--cuesheet-daemon-port=0"])).toBeUndefined();
    expect(parseDaemonPort(["--cuesheet-daemon-port=99999"])).toBeUndefined();
    expect(parseDaemonPort(["--cuesheet-daemon-port=oops"])).toBeUndefined();
    // `parseInt` would happily read this as 73 and the Desk would fetch from
    // a port nothing is listening on.
    expect(parseDaemonPort(["--cuesheet-daemon-port=73.7"])).toBeUndefined();
  });
});

describe("devServerUrl", () => {
  it("defaults to the Desk's vite port", () => {
    expect(devServerUrl({})).toBe(DEFAULT_DEV_SERVER);
  });

  it("honours an override, and ignores an empty one", () => {
    expect(devServerUrl({ CUESHEET_DEV_SERVER: "http://localhost:4000" })).toBe(
      "http://localhost:4000",
    );
    expect(devServerUrl({ CUESHEET_DEV_SERVER: "" })).toBe(DEFAULT_DEV_SERVER);
  });
});

describe("uiIndexCandidates", () => {
  it("finds the sibling package from a checkout", () => {
    const candidates = uiIndexCandidates({
      packaged: false,
      dirname: "/repo/packages/desktop/dist",
      path: path.posix,
    });
    expect(candidates).toContain("/repo/packages/ui/dist/index.html");
  });

  it("prefers the resources directory once packaged", () => {
    const candidates = uiIndexCandidates({
      packaged: true,
      dirname: "/App/Contents/Resources/app.asar/dist",
      resourcesPath: "/App/Contents/Resources",
      path: path.posix,
    });
    expect(candidates[0]).toBe("/App/Contents/Resources/ui/index.html");
  });

  it("never offers a resources path when not packaged", () => {
    // `process.resourcesPath` exists in a dev run too, pointing inside the
    // Electron binary's own bundle. Trusting it there loads somebody else's
    // index.html.
    const candidates = uiIndexCandidates({
      packaged: false,
      dirname: "/repo/packages/desktop/dist",
      resourcesPath:
        "/node_modules/electron/dist/Electron.app/Contents/Resources",
      path: path.posix,
    });
    expect(candidates.some((c) => c.includes("node_modules/electron"))).toBe(
      false,
    );
  });

  it("never offers a checkout path to a packaged app", () => {
    // The mirror of the test above, and the one that fails in production
    // rather than in dev: inside an asar this path resolves to something
    // strange, and a hit would serve a stale checkout's Desk.
    const candidates = uiIndexCandidates({
      packaged: true,
      dirname: "/App/Contents/Resources/app.asar/dist",
      resourcesPath: "/App/Contents/Resources",
      path: path.posix,
    });
    expect(candidates.some((c) => c.includes("ui/dist/index.html"))).toBe(
      false,
    );
  });

  it("emits Windows separators on Windows", () => {
    // Asserted from a Mac, which is the whole reason `path` is injectable.
    const candidates = uiIndexCandidates({
      packaged: false,
      dirname: "C:\\Users\\noah\\cuesheet\\packages\\desktop\\dist",
      path: path.win32,
    });
    expect(candidates).toContain(
      "C:\\Users\\noah\\cuesheet\\packages\\ui\\dist\\index.html",
    );
  });
});

describe("bridgeArguments", () => {
  it("gives a file:// page the port, since it has no origin to be relative to", () => {
    expect(parseDaemonPort(bridgeArguments("file", 7373))).toBe(7373);
  });

  it("withholds the port from the dev server", () => {
    // Found by running it: with a port, `apiOrigin()` returns an absolute
    // `http://127.0.0.1:7373`, which is a different origin from
    // `http://localhost:5173`. The daemon sends no CORS headers on purpose,
    // so every fetch fails as "Failed to fetch" behind a window that looks
    // fine. Relative URLs go through Vite's proxy and work.
    expect(bridgeArguments("dev-server", 7373)).toEqual([]);
  });
});

describe("tray assets", () => {
  it("asks for a template image on macOS and an .ico on Windows", () => {
    // macOS recolours a template for light, dark, and highlighted menu bars;
    // Windows has no such convention and resamples a PNG badly at the DPI
    // scales its taskbar actually uses.
    expect(trayIconName("darwin")).toBe("iconTemplate.png");
    expect(trayIconName("linux")).toBe("iconTemplate.png");
    expect(trayIconName("win32")).toBe("tray.ico");
  });

  it("finds assets beside the package in a checkout", () => {
    expect(
      assetCandidates(
        {
          packaged: false,
          dirname: "/repo/packages/desktop/dist",
          path: path.posix,
        },
        "iconTemplate.png",
      ),
    ).toEqual(["/repo/packages/desktop/assets/iconTemplate.png"]);
  });

  it("looks only in resources once packaged", () => {
    // Same trap as the Desk's own entry: `process.resourcesPath` exists in a
    // dev run too, pointing inside Electron's own bundle.
    expect(
      assetCandidates(
        {
          packaged: true,
          dirname: "/App/Contents/Resources/app.asar/dist",
          resourcesPath: "/App/Contents/Resources",
          path: path.posix,
        },
        "tray.ico",
      ),
    ).toEqual(["/App/Contents/Resources/assets/tray.ico"]);
  });
});
