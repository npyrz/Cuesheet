import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/** Select one committed section, never the history below it. */
export function changelogSection(markdown, name = "Unreleased") {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const starts = lines.flatMap((line, index) =>
    /^## \[([^\]]+)\](?:\s.*)?$/.exec(line)?.[1] === name ? [index] : [],
  );
  if (starts.length !== 1)
    throw new Error(`Expected exactly one [${name}] changelog section.`);
  const start = starts[0] + 1;
  const next = lines.findIndex(
    (line, index) => index >= start && /^## /.test(line),
  );
  const body = lines
    .slice(start, next === -1 ? undefined : next)
    .join("\n")
    .trim();
  const content = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^#+.*$/gm, "")
    .trim();
  if (!content)
    throw new Error(`The [${name}] changelog section has no release notes.`);
  return body;
}

export function renderReleaseNotes(
  changelog,
  { repository, sha, branch, section = "Unreleased" },
) {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
    !/^[a-f0-9]{40}$/.test(sha) ||
    !branch
  ) {
    throw new Error(
      "Release notes require a repository, full commit SHA and branch.",
    );
  }
  // Branch names are metadata, not trusted Markdown or shell fragments.
  const safeBranch = branch.replace(
    /[&<>"'`]/g,
    (char) => `&#${char.charCodeAt(0)};`,
  );
  const source = `https://github.com/${repository}/blob/${sha}/CHANGELOG.md`;
  return `Automated **${branch === "main" ? "Production" : "Prerelease"}** build from branch <code>${safeBranch}</code> at commit [${sha.slice(0, 7)}](https://github.com/${repository}/commit/${sha}).

The packaged version is in each download's filename. Changes below come from the committed [changelog](${source}); Unreleased entries are cumulative since the last named milestone.

## Changes

${changelogSection(changelog, section)}

## Installing

- **macOS** — signed with Developer ID and notarized. Drag Cuesheet into Applications.
- **Windows** — signed installer. Microsoft controls SmartScreen reputation; a new publisher may still receive a warning.
- **Updates** — main-branch installs check Latest automatically. Choose *Check for updates*, then *Restart and install*. Branch prereleases require manual installation. Active and queued runs are saved as interrupted before restart.

See the [release guide](https://github.com/${repository}/blob/${sha}/docs/releases.md) for details.
`;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const destination = process.argv[2];
  if (!destination)
    throw new Error("Usage: node scripts/release-notes.mjs <output.md>");
  const changelog = await readFile(
    new URL("../CHANGELOG.md", import.meta.url),
    "utf8",
  );
  const notes = renderReleaseNotes(changelog, {
    repository: process.env.GITHUB_REPOSITORY,
    sha: process.env.GITHUB_SHA,
    branch: process.env.GITHUB_REF_NAME,
    section: process.env.CHANGELOG_SECTION ?? "Unreleased",
  });
  await writeFile(destination, notes);
}
