/**
 * Set the product version, everywhere it is written down.
 *
 * ```
 * node scripts/set-version.mjs 0.1.0-alpha
 * ```
 *
 * There are eight copies of this number and they have to agree, because three
 * different consumers read three different ones:
 *
 * - **`electron-builder`** takes the installer filename and the app's About
 *   box from `packages/desktop/package.json`. A `v0.1.0-alpha` tag built
 *   against `0.0.0` ships installers called `0.0.0`.
 * - **`/health`** answers with `DAEMON_VERSION`, which is a *literal* in
 *   `packages/daemon/src/version.ts` on purpose: the daemon is bundled into
 *   one CJS file inside an asar, where reading a sibling `package.json` at
 *   runtime is a packaging problem rather than a one-liner. A literal
 *   survives bundling untouched — but only this script keeps it true.
 * - **`npm`**, if `@cuesheet/cli` is ever published.
 *
 * Hence: one command writes them all, and `version.test.ts` fails the build
 * if they ever drift. Generating `version.ts` at build time instead would
 * mean a fresh clone that does not typecheck until something has been built,
 * which is worse than a checked-in literal with a test behind it.
 *
 * This deliberately does not commit or tag. Tagging is a human's decision.
 */
import { readFile, writeFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * Semver, including a prerelease tail — `0.1.0-alpha` and `0.1.0-alpha.2` are
 * both things this project will want. Build metadata (`+sha`) is refused: npm
 * tolerates it and several release tools quietly do not.
 */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const version = process.argv[2];
if (version === undefined || !SEMVER.test(version)) {
  console.error(
    `Usage: node scripts/set-version.mjs <version>\n` +
      `  e.g. 0.1.0-alpha, 0.1.0-alpha.2, 0.1.0\n` +
      (version === undefined ? "" : `\nNot a version: ${version}\n`),
  );
  process.exit(1);
}

/** Rewrites one JSON file's `version` field, preserving everything else. */
async function setPackageVersion(file) {
  const text = await readFile(file, "utf8");
  const json = JSON.parse(text);
  if (json.version === version) return false;
  json.version = version;
  await writeFile(file, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  return true;
}

const files = [path.join(root, "package.json")];
const packagesDir = path.join(root, "packages");
for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
  if (entry.isDirectory()) {
    files.push(path.join(packagesDir, entry.name, "package.json"));
  }
}

const changed = [];
for (const file of files) {
  if (await setPackageVersion(file)) changed.push(path.relative(root, file));
}

// The literal. Matched on the assignment rather than on the old value, so the
// script does not need to know what the version used to be.
const versionTs = path.join(root, "packages/daemon/src/version.ts");
const source = await readFile(versionTs, "utf8");
const updated = source.replace(
  /export const DAEMON_VERSION = "[^"]*";/,
  `export const DAEMON_VERSION = "${version}";`,
);
if (updated === source && !source.includes(`"${version}"`)) {
  console.error(
    `Could not find the DAEMON_VERSION literal in ${versionTs}.\n` +
      `If it was renamed, this script and version.test.ts both need updating.`,
  );
  process.exit(1);
}
if (updated !== source) {
  await writeFile(versionTs, updated, "utf8");
  changed.push(path.relative(root, versionTs));
}

if (changed.length === 0) {
  console.log(`Already at ${version}. Nothing to do.`);
} else {
  console.log(`Set version ${version} in:`);
  for (const file of changed) console.log(`  ${file}`);
  console.log(`\nRun \`npm install\` to refresh package-lock.json.`);
}
