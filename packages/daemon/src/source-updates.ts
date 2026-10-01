/** Source installs follow published GitHub releases, never an arbitrary branch tip. */
import { realpath, open, rm } from "node:fs/promises";
import nodePath from "node:path";
import { run } from "@cuesheet/harness";
import { hostEnv, type HostEnv } from "@cuesheet/core";
import { findRunningDaemon } from "./lockfile.js";
import type { UpdateService, UpdateStatus } from "./updates.js";
import { DAEMON_VERSION } from "./version.js";

const REPOSITORY = "https://github.com/npyrz/Cuesheet.git";
const API = "https://api.github.com/repos/npyrz/Cuesheet/releases";
type Runner = typeof run;
export interface SourceUpdateOptions {
  root: string;
  tag?: string;
  fetcher?: typeof fetch;
  runner?: Runner;
  env?: HostEnv;
  /** Tests supply liveness without touching the developer's real lockfile. */
  running?: () => Promise<boolean>;
}
interface Release {
  tag_name: string;
  draft: boolean;
  prerelease?: boolean;
  published_at?: string;
}

async function command(
  options: SourceUpdateOptions,
  bin: string,
  args: readonly string[],
  timeoutMs = 30_000,
): Promise<string> {
  const result = await (options.runner ?? run)(bin, args, {
    cwd: options.root,
    timeoutMs,
  });
  if (result.code !== 0)
    throw new Error(
      `${bin} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  return result.stdout.trim();
}

async function checkout(options: SourceUpdateOptions): Promise<string> {
  const root = await realpath(options.root);
  const top = await realpath(
    await command(options, "git", ["rev-parse", "--show-toplevel"]),
  );
  if (root !== top)
    throw new Error("Updates require the Cuesheet checkout root.");
  const pkg = JSON.parse(
    await command(options, "git", ["show", "HEAD:package.json"]),
  ) as { name?: string };
  if (pkg.name !== "cuesheet")
    throw new Error("This is not a Cuesheet checkout.");
  return command(options, "git", ["rev-parse", "HEAD"]);
}

export async function inspectSourceUpdate(
  options: SourceUpdateOptions,
): Promise<UpdateStatus> {
  const revision = await checkout(options);
  const fetcher = options.fetcher ?? fetch;
  const request = {
    headers: { Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(15_000),
  };
  let response = await fetcher(
    options.tag
      ? `${API}/tags/${encodeURIComponent(options.tag)}`
      : `${API}/latest`,
    request,
  );
  if (response.status === 404 && !options.tag) {
    response = await fetcher(`${API}?per_page=100`, {
      ...request,
      signal: AbortSignal.timeout(15_000),
    });
  }
  if (!response.ok)
    throw new Error(
      `GitHub release check failed (${response.status}). Try again later.`,
    );
  const body: unknown = await response.json();
  let release: Release;
  if (options.tag || !Array.isArray(body)) release = body as Release;
  else {
    const published = (body as Release[])
      .filter((entry) => entry && entry.draft === false)
      .sort((a, b) =>
        (b.published_at ?? "").localeCompare(a.published_at ?? ""),
      );
    // This repository currently has only prereleases. Once a stable release
    // exists, branch development builds must not replace it for ordinary users.
    const selected =
      published.find((entry) => entry.prerelease === false) ?? published[0];
    if (!selected)
      return {
        phase: "idle",
        mode: "source",
        currentVersion: DAEMON_VERSION,
        currentRevision: revision,
        message: "No published releases yet. This checkout was left unchanged.",
      };
    release = selected;
  }
  // Tags are argv, not shell text, but rejecting option-like refs also protects Git.
  if (
    !release ||
    release.draft !== false ||
    typeof release.tag_name !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(release.tag_name)
  ) {
    throw new Error("GitHub returned an invalid or unpublished release.");
  }
  const fetched = `refs/cuesheet/releases/${release.tag_name}`;
  await command(options, "git", [
    "fetch",
    "--no-tags",
    "--no-write-fetch-head",
    REPOSITORY,
    `refs/tags/${release.tag_name}:${fetched}`,
  ]);
  const target = await command(options, "git", [
    "rev-parse",
    `${fetched}^{commit}`,
  ]);
  const base: UpdateStatus = {
    phase: "idle",
    mode: "source",
    currentVersion: DAEMON_VERSION,
    currentRevision: revision,
    targetRevision: target,
    version: release.tag_name,
    command: options.tag
      ? `npm run update -- --tag ${release.tag_name}`
      : "npm run update",
    checkout: options.root,
  };
  if (target === revision)
    return {
      ...base,
      message: "This checkout is at the latest published release.",
    };
  const ancestor = await (options.runner ?? run)(
    "git",
    ["merge-base", "--is-ancestor", revision, target],
    { cwd: options.root, timeoutMs: 30_000 },
  );
  if (ancestor.code === 1) {
    const ahead = await (options.runner ?? run)(
      "git",
      ["merge-base", "--is-ancestor", target, revision],
      { cwd: options.root, timeoutMs: 30_000 },
    );
    if (ahead.code !== 0 && ahead.code !== 1)
      throw new Error(`Cannot compare release history: ${ahead.stderr}`);
    return {
      ...base,
      phase: ahead.code === 0 ? "idle" : "unavailable",
      message:
        ahead.code === 0
          ? "This checkout is ahead of the published release. No downgrade will be applied."
          : "This checkout has diverged from the published release. Merge it manually; Cuesheet will not overwrite your commits.",
    };
  }
  if (ancestor.code !== 0)
    throw new Error(`Cannot compare release history: ${ancestor.stderr}`);
  return {
    ...base,
    phase: "available",
    message: `Release ${release.tag_name} is available. Stop Cuesheet and any Vite dev server, then run npm run update in the Cuesheet checkout and restart your app or daemon.`,
  };
}

/** The HTTP surface checks; the operator's terminal performs the stopped update. */
export function createSourceUpdates(
  options: SourceUpdateOptions,
): UpdateService {
  let state: UpdateStatus = {
    phase: "idle",
    mode: "source",
    currentVersion: DAEMON_VERSION,
    message: "Check GitHub for a published source update.",
  };
  let checking: Promise<void> | undefined;
  return {
    status: () => ({ ...state }),
    check() {
      if (checking) return checking;
      state = { ...state, phase: "checking" };
      checking = inspectSourceUpdate(options)
        .then((next) => {
          state = next;
        })
        .catch((error: unknown) => {
          state = {
            phase: "error",
            mode: "source",
            currentVersion: DAEMON_VERSION,
            message: error instanceof Error ? error.message : String(error),
          };
        })
        .finally(() => {
          checking = undefined;
        });
      return checking;
    },
    prepareInstall() {
      throw new Error(
        "Stop Cuesheet, then run npm run update in its checkout.",
      );
    },
    restart() {},
  };
}

export async function applySourceUpdate(
  options: SourceUpdateOptions,
): Promise<UpdateStatus> {
  await checkout(options);
  // A lock in Git's private directory survives the checkout itself and serializes
  // two terminal invocations without leaving an untracked file in the worktree.
  const lockPath = nodePath.resolve(
    options.root,
    await command(options, "git", [
      "rev-parse",
      "--git-path",
      "cuesheet-update.lock",
    ]),
  );
  const lock = await open(lockPath, "wx");
  let original: string | undefined;
  let moved = false;
  try {
    const running =
      options.running ??
      (async () =>
        (await findRunningDaemon(options.env ?? hostEnv())) !== null);
    if (await running())
      throw new Error(
        "Stop Cuesheet's app or daemon before updating; active runs must finish or be interrupted normally.",
      );
    if (await command(options, "git", ["status", "--porcelain"]))
      throw new Error(
        "Commit or stash local changes, including untracked files, before updating.",
      );
    const status = await inspectSourceUpdate(options);
    if (status.phase !== "available") return status;
    // Recheck after network access: a user may have edited or started work meanwhile.
    if (await running())
      throw new Error(
        "Cuesheet started during the update check. Stop it before updating.",
      );
    if (await command(options, "git", ["status", "--porcelain"]))
      throw new Error(
        "Local changes appeared during the update check. Update refused.",
      );
    original = await command(options, "git", ["rev-parse", "HEAD"]);
    if (original !== status.currentRevision)
      throw new Error(
        "The checkout changed during the release check. Try again.",
      );
    await command(options, "git", [
      "merge",
      "--ff-only",
      "--no-overwrite-ignore",
      status.targetRevision!,
    ]);
    moved = true;
    try {
      await command(options, "npm", ["ci"], 600_000);
      await command(options, "npm", ["run", "build"], 600_000);
    } catch (error) {
      // Never reset --hard or clean: a failed install must not discard user files.
      // Restore only if the tracked checkout still matches the fetched commit.
      const edits = await command(options, "git", [
        "status",
        "--porcelain",
        "--untracked-files=no",
      ]);
      const head = await command(options, "git", ["rev-parse", "HEAD"]);
      if (edits || head !== status.targetRevision)
        throw new Error(
          `Build failed and the checkout changed; left untouched at ${head}. ${String(error)}`,
          { cause: error },
        );
      await command(options, "git", [
        "restore",
        "--source",
        original!,
        "--staged",
        "--worktree",
        ":/",
      ]);
      await command(options, "git", ["reset", "--soft", original!]);
      await command(options, "npm", ["ci"], 600_000);
      await command(options, "npm", ["run", "build"], 600_000);
      throw new Error(
        `Update failed. Restored and rebuilt the previous checkout. ${String(error)}`,
        { cause: error },
      );
    }
    return {
      ...status,
      phase: "idle",
      currentRevision: status.targetRevision!,
      message: `Updated to ${status.version}. Restart your app or daemon. User state in ~/.cuesheet was left untouched.`,
    };
  } catch (error) {
    if (moved && original)
      throw new Error(`${String(error)} Previous commit: ${original}.`, {
        cause: error,
      });
    throw error;
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
