/** The checkout path comes from this script, never the user's project directory. */
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
try {
  const check = args.includes("--check");
  const tagIndex = args.indexOf("--tag");
  const tag = tagIndex >= 0 ? args[tagIndex + 1] : undefined;
  const known = args.filter(
    (_, i) => tagIndex < 0 || (i !== tagIndex && i !== tagIndex + 1),
  );
  if (known.some((arg) => arg !== "--check") || (tagIndex >= 0 && !tag))
    throw new Error(
      "Usage: npm run update [-- --check] [-- --tag RELEASE_TAG]",
    );
  const { applySourceUpdate, inspectSourceUpdate } =
    await import("../packages/daemon/dist/index.js");
  const root = nodePath.resolve(
    nodePath.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const options = { root, ...(tag && { tag }) };
  const status = await (check
    ? inspectSourceUpdate(options)
    : applySourceUpdate(options));
  console.log(status.message);
  if (status.phase === "unavailable") process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
