import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

// Exercise the same JS policy electron-builder imports, without loading a
// platform packager (and without putting credentials into a child command).
const policyPath = new URL("../release-policy.mjs", import.meta.url).href;
const { requireSigning, releaseVersion } = (await import(policyPath)) as {
  requireSigning(platform: string, env: Record<string, string>): void;
  releaseVersion(base: string, run: string, attempt: string): string;
};
const require = createRequire(import.meta.url);
const { gt } = require("semver") as { gt(a: string, b: string): boolean };

describe("signed release policy", () => {
  it("refuses missing credentials and ad-hoc macOS identities", () => {
    expect(() => requireSigning("darwin", {})).toThrow(
      "APPLE_APP_SPECIFIC_PASSWORD",
    );
    expect(() => requireSigning("win32", {})).toThrow("WINDOWS_PUBLISHER_NAME");
    expect(() => requireSigning("linux", {})).toThrow("macOS and Windows only");
    const env = {
      CSC_LINK: "private-value",
      CSC_KEY_PASSWORD: "private-value",
      MAC_SIGNING_IDENTITY: "-",
      APPLE_ID: "private-value",
      APPLE_APP_SPECIFIC_PASSWORD: "private-value",
      APPLE_TEAM_ID: "private-value",
    };
    expect(() => requireSigning("darwin", env)).toThrow(
      "Developer ID Application",
    );
    expect(() =>
      requireSigning("darwin", {
        ...env,
        MAC_SIGNING_IDENTITY: "Developer ID Application: Example (TEAM)",
      }),
    ).not.toThrow();
    expect(() =>
      requireSigning("win32", {
        CSC_LINK: "private-value",
        CSC_KEY_PASSWORD: "private-value",
        WINDOWS_PUBLISHER_NAME: "Example",
      }),
    ).not.toThrow();
  });

  it("gives successive commits and retries greater semver precedence without promoting maturity", () => {
    const a = releaseVersion("0.1.0-alpha", "9", "1");
    const b = releaseVersion("0.1.0-alpha", "10", "1");
    const c = releaseVersion("0.1.0-alpha", "10", "2");
    expect(gt(b, a)).toBe(true);
    expect(gt(c, b)).toBe(true);
    expect(gt("0.1.0", c)).toBe(true);
    expect(() => releaseVersion("0.1.0-alpha", "", "1")).toThrow();
  });

  it("keeps the signing gate and updater assets in the publication path", () => {
    const workflow = readFileSync(
      new URL("../../../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );
    expect(workflow).toContain("--config electron-builder.release.mjs");
    expect(workflow).toContain("xcrun stapler validate");
    expect(workflow).toContain("Get-AuthenticodeSignature");
    expect(workflow).toContain("release/latest*.yml");
    expect(workflow).toContain("release/*.blockmap");
    expect(workflow).toContain("needs: build");
  });
});
