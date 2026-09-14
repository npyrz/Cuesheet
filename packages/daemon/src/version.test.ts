/**
 * The version is written down in eight places and they have to agree.
 *
 * This test lives here, beside the literal, because the literal is the copy
 * with no mechanism behind it: `package.json` versions are at least bumped by
 * a tool people already know, while `DAEMON_VERSION` is a string in a source
 * file that a release will happily leave stale. `/health` would then report
 * `0.0.0` from a `0.1.0-alpha` build and the first bug report would carry the
 * wrong version in it.
 *
 * `node scripts/set-version.mjs <version>` is what makes them agree.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DAEMON_VERSION } from "./version.js";

const root = fileURLToPath(new URL("../../..", import.meta.url));

function versionOf(packageJson: string): string {
  const raw: unknown = JSON.parse(readFileSync(packageJson, "utf8"));
  const version = (raw as { version?: unknown }).version;
  if (typeof version !== "string") {
    throw new Error(`${packageJson} has no version field.`);
  }
  return version;
}

describe("the product version", () => {
  const rootVersion = versionOf(path.join(root, "package.json"));

  it("is a semver the release tooling will accept", () => {
    // `electron-builder` and `gh release create` both take this string. A
    // build-metadata tail (`+sha`) is valid semver that several release tools
    // quietly mishandle, so it is refused here as well as in the script.
    expect(rootVersion).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });

  it("is what `/health` reports", () => {
    expect(DAEMON_VERSION).toBe(rootVersion);
  });

  it("is what every workspace package claims", () => {
    // `packages/desktop` is the one that decides what the installer is
    // called, but a workspace where only some versions moved is a worse
    // failure than one where none did: it looks fine until you read a
    // filename.
    const packagesDir = path.join(root, "packages");
    const mismatched = readdirSync(packagesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        version: versionOf(path.join(packagesDir, entry.name, "package.json")),
      }))
      .filter((pkg) => pkg.version !== rootVersion);

    expect(mismatched).toEqual([]);
  });
});
