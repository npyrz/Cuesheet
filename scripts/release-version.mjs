import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { releaseVersion } from "../packages/desktop/release-policy.mjs";

const root = new URL("../", import.meta.url);
const { version } = JSON.parse(
  await readFile(new URL("package.json", root), "utf8"),
);
const next = releaseVersion(
  version,
  process.env.GITHUB_RUN_NUMBER,
  process.env.GITHUB_RUN_ATTEMPT,
);
execFileSync(
  process.execPath,
  [fileURLToPath(new URL("scripts/set-version.mjs", root)), next],
  { stdio: "inherit" },
);
