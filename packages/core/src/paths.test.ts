import { describe, expect, it } from "vitest";
import {
  type HostEnv,
  commonsDir,
  configDir,
  configFile,
  daemonLockFile,
  expandHome,
  isWindows,
  logsDir,
  resolveUserPath,
  runsDir,
  toPosix,
} from "./paths.js";

const mac: HostEnv = { platform: "darwin", homedir: "/Users/noah" };
const win: HostEnv = { platform: "win32", homedir: "C:\\Users\\noah" };

describe("platform detection", () => {
  it("identifies windows", () => {
    expect(isWindows(win)).toBe(true);
    expect(isWindows(mac)).toBe(false);
  });
});

describe("well-known directories", () => {
  it("resolves under the home dir on macOS", () => {
    expect(configDir(mac)).toBe("/Users/noah/.cuesheet");
    expect(configFile(mac)).toBe("/Users/noah/.cuesheet/cuesheet.toml");
    expect(runsDir(mac)).toBe("/Users/noah/.cuesheet/runs");
    expect(logsDir(mac)).toBe("/Users/noah/.cuesheet/logs");
    expect(commonsDir(mac)).toBe("/Users/noah/.cuesheet/commons");
    expect(daemonLockFile(mac)).toBe("/Users/noah/.cuesheet/daemon.json");
  });

  it("resolves with backslashes on Windows, from any host", () => {
    expect(configDir(win)).toBe("C:\\Users\\noah\\.cuesheet");
    expect(configFile(win)).toBe("C:\\Users\\noah\\.cuesheet\\cuesheet.toml");
    expect(runsDir(win)).toBe("C:\\Users\\noah\\.cuesheet\\runs");
    expect(daemonLockFile(win)).toBe("C:\\Users\\noah\\.cuesheet\\daemon.json");
  });
});

describe("expandHome", () => {
  it("expands a bare tilde", () => {
    expect(expandHome("~", mac)).toBe("/Users/noah");
    expect(expandHome("~", win)).toBe("C:\\Users\\noah");
  });

  it("expands a tilde prefix", () => {
    expect(expandHome("~/code/api", mac)).toBe("/Users/noah/code/api");
    expect(expandHome("~/code/api", win)).toBe("C:\\Users\\noah\\code\\api");
  });

  it("expands a backslash tilde prefix only on Windows", () => {
    expect(expandHome("~\\code\\api", win)).toBe("C:\\Users\\noah\\code\\api");
    // On POSIX this is a single relative filename that happens to start with ~.
    expect(expandHome("~\\code\\api", mac)).toBe("~\\code\\api");
  });

  it("leaves everything else alone", () => {
    expect(expandHome("/abs/path", mac)).toBe("/abs/path");
    expect(expandHome("./rel", mac)).toBe("./rel");
    expect(expandHome("~user/code", mac)).toBe("~user/code");
    expect(expandHome("C:\\code\\api", win)).toBe("C:\\code\\api");
  });
});

describe("toPosix", () => {
  it("rewrites separators on Windows", () => {
    expect(toPosix("C:\\code\\api\\src\\index.ts", win)).toBe(
      "C:/code/api/src/index.ts",
    );
  });

  it("leaves POSIX paths untouched, backslashes included", () => {
    // A backslash is a legal character in a POSIX filename. Rewriting it here
    // would silently corrupt a real path.
    expect(toPosix("/code/api/weird\\name.ts", mac)).toBe(
      "/code/api/weird\\name.ts",
    );
  });
});

describe("resolveUserPath", () => {
  it("expands and absolutizes against cwd", () => {
    expect(resolveUserPath("~/code/api", "/tmp", mac)).toBe(
      "/Users/noah/code/api",
    );
    expect(resolveUserPath("src", "/code/api", mac)).toBe("/code/api/src");
    expect(resolveUserPath("src", "C:\\code\\api", win)).toBe(
      "C:\\code\\api\\src",
    );
  });
});
