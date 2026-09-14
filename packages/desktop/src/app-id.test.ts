/**
 * `APP_ID` and `electron-builder.yml`'s `appId` are one decision in two files.
 *
 * Windows drops every toast from a process whose AppUserModelID does not match
 * the one registered by the installed app's Start Menu shortcut — silently, with
 * no error to read. So a typo here does not fail a build, fail a test, or log
 * anything: notifications simply never appear, on the one platform where the
 * standby notification is the whole point of Step 22. The macOS build is
 * unaffected, which is what makes it easy to ship.
 *
 * PLAN-STEP.MD Step 24 records that these two strings must agree; this is the
 * thing that makes it true rather than remembered.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const appIdIn = (file: string): string => {
  const text = readFileSync(
    fileURLToPath(new URL(file, import.meta.url)),
    "utf8",
  );
  const match = /^appId:\s*(\S+)\s*$/m.exec(text);
  if (match?.[1] === undefined) {
    throw new Error(`No appId found in ${file}.`);
  }
  return match[1];
};

const constantIn = (file: string): string => {
  const text = readFileSync(
    fileURLToPath(new URL(file, import.meta.url)),
    "utf8",
  );
  const match = /^const APP_ID = "([^"]+)";$/m.exec(text);
  if (match?.[1] === undefined) {
    throw new Error(`No APP_ID constant found in ${file}.`);
  }
  return match[1];
};

describe("the application id", () => {
  it("is the same string the installer registers", () => {
    expect(constantIn("./main.ts")).toBe(appIdIn("../electron-builder.yml"));
  });

  it("is a reverse-DNS id, which is what Windows and macOS both expect", () => {
    expect(constantIn("./main.ts")).toMatch(/^[a-z0-9]+(\.[a-z0-9-]+)+$/);
  });
});
