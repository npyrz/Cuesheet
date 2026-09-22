/**
 * The Commons store — facts on disk, in a git repository the operator owns.
 *
 * The README's promise is the whole specification: *"It is plain markdown in a
 * repo you own — you can read it, grep it, diff it, and leave."* So this file
 * writes files and shells out to `git`, and it never reaches for a database or
 * an index. `core/commons.ts` owns the format and the id rules; what is here
 * is the disk, the commits, and the honesty about what happens when `git` is
 * not there.
 *
 * ## `git` is optional, and a missing one is not a failed write
 *
 * Every other subprocess in this repo probes before it spawns and degrades
 * with a stated reason. This does the same, and the reasoning is the README's:
 * the value being promised is *plain markdown in a folder*. History is what
 * makes that folder a Commons rather than a directory, but losing history is a
 * degraded store, not a broken one — and a write that throws because `git` is
 * not on somebody's PATH would be the wrong failure at the worst moment.
 *
 * Every mutation reports whether it was committed, so a caller can say so
 * rather than implying a history that is not there.
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import {
  commonsDir,
  hostEnv,
  isFactId,
  parseFact,
  serializeFact,
  slugify,
  type Fact,
  type FactProvenance,
  type HostEnv,
} from "@cuesheet/core";
import { run, which } from "@cuesheet/harness";

/**
 * The identity on a Commons commit.
 *
 * Per-commit `-c` flags rather than `git config`, deliberately twice over. A
 * fresh machine has no `user.email` and a commit without one fails outright —
 * so an identity has to be supplied. Writing it into the operator's global
 * config to achieve that would be Cuesheet reaching outside its own directory
 * to change how every other repository on the machine commits, which it has no
 * business doing.
 *
 * And it names Cuesheet rather than the operator. A machine-written commit
 * attributed to a person is a lie in the one place — `git log` — that exists
 * to answer who did something.
 */
export const COMMONS_AUTHOR_NAME = "Cuesheet";
export const COMMONS_AUTHOR_EMAIL = "commons@cuesheet.local";

/** Long enough for a first `git init` on a cold filesystem. */
const GIT_TIMEOUT_MS = 10_000;

export interface CommonsOptions {
  env?: HostEnv;
  /** Overrides `~/.cuesheet/commons`. Tests must pass one or an isolated env. */
  root?: string;
  /** Injectable clock, so provenance is assertable without sleeping. */
  now?: () => Date;
  /** Override the `git` binary. Absent means resolve it from PATH. */
  gitBin?: string;
}

export interface WriteFactInput {
  /** Omitted means derive one from the title. */
  id?: string;
  title: string;
  body: string;
  tags?: string[];
  projects?: string[];
  station?: string;
  run?: string;
  /** Preserve an agent capture time when an inbox item is approved later. */
  at?: string;
}

/** What a mutation did, including whether history recorded it. */
export interface CommonsWrite {
  fact: Fact;
  /** False when `git` is unavailable — the file is still written. */
  committed: boolean;
  /** Why history is unavailable, when it is. */
  reason?: string;
}

export interface CommonsStore {
  /** Absolute path of the repository. Handy for "open in Finder" and for tests. */
  readonly root: string;
  list(): Promise<Fact[]>;
  get(id: string): Promise<Fact | null>;
  write(input: WriteFactInput): Promise<CommonsWrite>;
  remove(id: string): Promise<CommonsWrite | null>;
  /**
   * One line per commit, newest first.
   *
   * Returns a `reason` rather than collapsing into an empty list, because the
   * store distinguishes "cannot" from "nothing" everywhere else — `committed`
   * plus `reason` on every write is that same discipline — and a fresh
   * repository with no commits, a missing `git` and a broken one are three
   * different things an operator would want told apart. Step 48's inbox needs
   * to say "history is unavailable", not "nothing has happened".
   */
  history(limit?: number): Promise<CommonsHistory>;
  /** Local Git state only; reading status never contacts the remote. */
  syncStatus(): Promise<CommonsSyncStatus>;
  /** Add or replace the operator-owned `origin` remote. */
  configureSync(remote: string): Promise<CommonsSyncStatus>;
  /** Fetch and merge. A textual conflict is left in the worktree for a human. */
  pull(): Promise<CommonsSyncResult>;
  /** Push the current Commons branch to `origin`. */
  push(): Promise<CommonsSyncResult>;
  /** Commit a merge after the operator has resolved every conflicted file. */
  continueSync(): Promise<CommonsSyncResult>;
}

export interface CommonsHistory {
  /** `%h %s` per commit, newest first. Empty in a repository with no commits. */
  commits: string[];
  /** Present only when history could not be read at all. */
  reason?: string;
}

export interface CommonsSyncStatus {
  configured: boolean;
  /** Credentials in an HTTPS URL are never returned over the API. */
  remote?: string;
  branch?: string;
  merging: boolean;
  conflicts: string[];
}

export interface CommonsSyncResult extends CommonsSyncStatus {
  outcome: "up-to-date" | "pulled" | "pushed" | "conflict" | "resolved";
}

export class CommonsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommonsError";
  }
}

export class CommonsSyncError extends CommonsError {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "CommonsSyncError";
  }
}

export function createCommonsStore(options: CommonsOptions = {}): CommonsStore {
  const env = options.env ?? hostEnv();
  const root = options.root ?? commonsDir(env);
  const now = options.now ?? (() => new Date());

  /**
   * Resolved once and remembered, including the negative answer.
   *
   * `which` walks PATH, and a store that did it per write would pay for it on
   * every fact. A machine that gains `git` mid-session keeps the old answer
   * until restart, which is the right trade: the alternative is a PATH walk
   * per keystroke in the approval inbox of Step 48.
   */
  let gitPath: string | null | undefined;
  let operationTail: Promise<void> = Promise.resolve();

  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationTail.then(operation, operation);
    operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  async function git(): Promise<string | null> {
    if (gitPath === undefined) {
      gitPath = options.gitBin ?? (await which("git"));
    }
    return gitPath;
  }

  /**
   * Run `git`, turning a failure to *start* into an answer.
   *
   * `run` rejects when the binary cannot be spawned, and probing with `which`
   * first is not enough: a `git` that is on PATH at probe time and gone,
   * unreadable or not executable at spawn time throws from inside `spawn`.
   * Without this the store's whole promise — a missing git degrades rather
   * than fails a write — would hold only for the case somebody thought of.
   *
   * Found by a test that pointed `gitBin` at a file that does not exist, which
   * is exactly the shape of the real failure.
   */
  async function tryGit(
    args: readonly string[],
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const bin = await git();
    if (bin === null) {
      return { code: null, stdout: "", stderr: "`git` is not on your PATH." };
    }
    try {
      return await run(bin, args, { cwd: root, timeoutMs: GIT_TIMEOUT_MS });
    } catch (error) {
      return {
        code: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function ensureRepo(): Promise<{ ok: boolean; reason?: string }> {
    await mkdir(root, { recursive: true });

    if ((await git()) === null) {
      return {
        ok: false,
        reason:
          "`git` is not on your PATH, so the Commons keeps your facts as " +
          "files but cannot record their history.",
      };
    }

    // `rev-parse` rather than looking for a `.git` directory: a commons inside
    // a worktree, or one the operator turned into a submodule, is still a
    // repository and re-initialising it would be destructive.
    const inside = await tryGit(["rev-parse", "--git-dir"]);
    if (inside.code === 0) return { ok: true };

    const init = await tryGit(["init", "--quiet"]);
    if (init.code !== 0) {
      return {
        ok: false,
        reason: `\`git init\` failed in ${root}: ${init.stderr.trim()}`,
      };
    }

    // `init.defaultBranch` differs between machines. A Commons created on a
    // machine that says `master` and one that says `main` must still agree on
    // which branch they exchange, so new stores choose one explicitly. An
    // existing repository is never renamed.
    const branch = await tryGit(["symbolic-ref", "HEAD", "refs/heads/main"]);
    if (branch.code !== 0) {
      return {
        ok: false,
        reason: `Could not select the Commons branch: ${branch.stderr.trim()}`,
      };
    }

    // Written by the store rather than left to the operator's global config.
    // A commons created on Windows otherwise commits CRLF markdown, and Step
    // 47's "re-running the projection twice produces no diff" would fail there
    // for a reason that has nothing to do with projections.
    await writeFile(
      `${root}/.gitattributes`,
      "* text=auto eol=lf\n*.md text eol=lf\n",
      "utf8",
    );
    return { ok: true };
  }

  async function commit(message: string): Promise<CommonsWrite["reason"]> {
    const repo = await ensureRepo();
    if (!repo.ok) return repo.reason;

    const conflicts = await conflictPaths();
    if (conflicts.length > 0) {
      return (
        "Commons sync has unresolved files: " +
        `${conflicts.join(", ")}. Resolve them before writing more history.`
      );
    }

    const staged = await tryGit(["add", "-A"]);
    if (staged.code !== 0) return `\`git add\` failed: ${staged.stderr.trim()}`;

    const done = await tryGit([
      "-c",
      `user.name=${COMMONS_AUTHOR_NAME}`,
      "-c",
      `user.email=${COMMONS_AUTHOR_EMAIL}`,
      "commit",
      "--quiet",
      "-m",
      message,
    ]);
    if (done.code !== 0) {
      // "nothing to commit" is a normal outcome — rewriting a fact with the
      // same contents changes no bytes — and is not worth reporting as a
      // failure to a caller who asked for the fact to be true.
      const output = `${done.stdout} ${done.stderr}`.toLowerCase();
      if (output.includes("nothing to commit")) return undefined;
      return `\`git commit\` failed: ${done.stderr.trim() || done.stdout.trim()}`;
    }
    return undefined;
  }

  /**
   * Hoisted out of the returned object rather than reached through `this`.
   *
   * `remove` needs it, and `this.get(...)` inside an object literal works only
   * while the method is called *as* a method — destructure the store, or pass
   * `remove` as a callback, and `this` is undefined. Nothing in the tests did
   * that, so nothing caught it; the closure is the shape everything else in
   * here already uses.
   */
  async function readFact(id: string): Promise<Fact | null> {
    if (!isFactId(id)) throw new CommonsError(`"${id}" is not a fact id.`);
    try {
      return parseFact(id, await readFile(fileFor(id), "utf8"));
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  function fileFor(id: string): string {
    // Never joined from unvalidated input. `isFactId` is checked by every
    // caller below before this is reached, which is what keeps a fact id from
    // being a path traversal.
    return `${root}/${id}.md`;
  }

  async function conflictPaths(): Promise<string[]> {
    const result = await tryGit(["diff", "--name-only", "--diff-filter=U"]);
    if (result.code !== 0) return [];
    return result.stdout
      .split("\n")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "")
      .sort();
  }

  async function mergeInProgress(): Promise<boolean> {
    return (
      (await tryGit(["rev-parse", "--verify", "-q", "MERGE_HEAD"])).code === 0
    );
  }

  async function currentBranch(): Promise<string | undefined> {
    const result = await tryGit(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const branch = result.stdout.trim();
    return result.code === 0 && branch !== "" ? branch : undefined;
  }

  async function remoteUrl(): Promise<string | undefined> {
    const result = await tryGit(["remote", "get-url", "origin"]);
    const remote = result.stdout.trim();
    return result.code === 0 && remote !== "" ? remote : undefined;
  }

  async function readSyncStatus(): Promise<CommonsSyncStatus> {
    const repo = await ensureRepo();
    if (!repo.ok)
      throw new CommonsSyncError(repo.reason ?? "Git is unavailable.");
    const [remote, branch, conflicts, merging] = await Promise.all([
      remoteUrl(),
      currentBranch(),
      conflictPaths(),
      mergeInProgress(),
    ]);
    return {
      configured: remote !== undefined,
      ...(remote !== undefined && { remote: redactRemote(remote) }),
      ...(branch !== undefined && { branch }),
      merging,
      conflicts,
    };
  }

  async function requireRemote(): Promise<string> {
    const remote = await remoteUrl();
    if (remote === undefined) {
      throw new CommonsSyncError(
        "No Commons remote is configured. Add the Git remote first.",
      );
    }
    return remote;
  }

  async function snapshotBeforeSync(): Promise<void> {
    const reason = await commit("Record local Commons before sync");
    if (reason !== undefined) throw new CommonsSyncError(reason, 409);
  }

  async function remoteBranches(): Promise<string[]> {
    const refs = await tryGit([
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/remotes/origin",
    ]);
    if (refs.code !== 0) {
      throw new CommonsSyncError(
        `Could not inspect the Commons remote: ${safeGitError(refs)}`,
      );
    }
    return (
      refs.stdout
        .split("\n")
        .map((line) => line.trim())
        // Some Git versions render the symbolic remote HEAD as bare `origin`
        // under `%(refname:short)`, others as `origin/HEAD`. Neither is a branch.
        .filter((line) => line.startsWith("origin/") && line !== "origin/HEAD")
        .map((line) => line.replace(/^origin\//, ""))
    );
  }

  async function configuredUpstream(): Promise<string | undefined> {
    const result = await tryGit([
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]);
    const upstream = result.stdout.trim();
    return result.code === 0 && upstream.startsWith("origin/")
      ? upstream.slice("origin/".length)
      : undefined;
  }

  async function remoteBranch(localBranch: string): Promise<string | null> {
    const configured = await configuredUpstream();
    if (configured !== undefined) return configured;

    const direct = await tryGit([
      "show-ref",
      "--verify",
      "--quiet",
      `refs/remotes/origin/${localBranch}`,
    ]);
    if (direct.code === 0) return localBranch;

    const branches = await remoteBranches();
    if (branches.length === 0) return null;
    if (branches.length === 1) return branches[0] ?? null;
    throw new CommonsSyncError(
      `The remote has several branches and none matches "${localBranch}".`,
      409,
    );
  }

  async function markerConflicts(paths: readonly string[]): Promise<string[]> {
    const unresolved: string[] = [];
    for (const name of paths) {
      if (name.startsWith("/") || name.split("/").includes("..")) {
        unresolved.push(name);
        continue;
      }
      try {
        const text = await readFile(`${root}/${name}`, "utf8");
        if (/^(<<<<<<< |=======|>>>>>>> )/m.test(text)) unresolved.push(name);
      } catch {
        // Deleting one side is a legitimate human resolution. `git add -A`
        // below records it, so a missing file is not itself unresolved.
      }
    }
    return unresolved;
  }

  return {
    root,

    async list(): Promise<Fact[]> {
      let names: string[];
      try {
        names = await readdir(root);
      } catch {
        // No commons yet is an empty commons, not an error. The first write
        // creates it.
        return [];
      }

      const facts: Fact[] = [];
      for (const name of names.sort()) {
        if (!name.endsWith(".md")) continue;
        const id = name.slice(0, -3);
        if (!isFactId(id)) continue;
        try {
          facts.push(parseFact(id, await readFile(fileFor(id), "utf8")));
        } catch {
          // A file somebody hand-edited into something else is skipped rather
          // than failing the listing. Step 48's inbox is where a malformed
          // fact gets shown to a human; a store that could not be listed at
          // all because of one bad file would make that unreachable.
          continue;
        }
      }
      return facts;
    },

    get: readFact,

    async write(input: WriteFactInput): Promise<CommonsWrite> {
      return exclusive(async () => {
        const id = input.id ?? slugFor(input.title);
        if (!isFactId(id)) {
          throw new CommonsError(
            `"${id}" is not a usable fact id. Lowercase letters, digits and ` +
              `single hyphens only.`,
          );
        }

        const provenance: FactProvenance = {
          ...(input.station !== undefined && { station: input.station }),
          ...(input.run !== undefined && { run: input.run }),
          at: input.at ?? now().toISOString(),
        };
        const fact: Fact = {
          id,
          title: input.title,
          tags: input.tags ?? [],
          projects: input.projects ?? [],
          provenance,
          body: input.body,
        };

        await mkdir(root, { recursive: true });
        await writeFile(fileFor(id), serializeFact(fact), "utf8");

        // Both halves of the provenance, answering different questions. The
        // frontmatter is what Step 47's projection and Step 48's inbox read; the
        // subject line is what `git log --oneline` answers with, which is the
        // literal thing this step has to be able to do.
        const reason = await commit(
          `${input.id === undefined ? "Add" : "Write"} ${id}\n\n` +
            `${fact.title}\n\n` +
            `Station: ${provenance.station ?? "(hand-written)"}\n` +
            `Run: ${provenance.run ?? "(none)"}\n` +
            `At: ${provenance.at}\n`,
        );

        return {
          fact,
          committed: reason === undefined,
          ...(reason !== undefined && { reason }),
        };
      });
    },

    async remove(id: string): Promise<CommonsWrite | null> {
      return exclusive(async () => {
        if (!isFactId(id)) throw new CommonsError(`"${id}" is not a fact id.`);
        const existing = await readFact(id);
        if (existing === null) return null;

        await rm(fileFor(id), { force: true });
        const reason = await commit(
          `Remove ${id}\n\n${existing.title}\n\nAt: ${now().toISOString()}\n`,
        );
        return {
          fact: existing,
          committed: reason === undefined,
          ...(reason !== undefined && { reason }),
        };
      });
    },

    async history(limit = 50): Promise<CommonsHistory> {
      const log = await tryGit([
        "log",
        `--max-count=${String(limit)}`,
        "--pretty=format:%h %s",
      ]);
      if (log.code !== 0) {
        // A repository that exists and has no commits is not a failure — git
        // says so on stderr in words, and an operator who has written nothing
        // should read "nothing", not "unavailable".
        const empty = /does not have any commits|bad default revision/i.test(
          log.stderr,
        );
        return empty
          ? { commits: [] }
          : { commits: [], reason: log.stderr.trim() || "`git log` failed." };
      }
      return {
        commits: log.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== ""),
      };
    },

    async syncStatus(): Promise<CommonsSyncStatus> {
      return exclusive(readSyncStatus);
    },

    async configureSync(remote: string): Promise<CommonsSyncStatus> {
      return exclusive(async () => {
        const value = remote.trim();
        if (value === "" || /[\r\n]/.test(value)) {
          throw new CommonsSyncError("`remote` must be a non-empty Git URL.");
        }
        const repo = await ensureRepo();
        if (!repo.ok) {
          throw new CommonsSyncError(repo.reason ?? "Git is unavailable.");
        }
        const existing = await remoteUrl();
        const changed = await tryGit([
          "remote",
          existing === undefined ? "add" : "set-url",
          "origin",
          value,
        ]);
        if (changed.code !== 0) {
          throw new CommonsSyncError(
            `Could not configure the Commons remote: ${safeGitError(changed)}`,
          );
        }
        return readSyncStatus();
      });
    },

    async pull(): Promise<CommonsSyncResult> {
      return exclusive(async () => {
        await requireRemote();
        const before = await readSyncStatus();
        if (before.conflicts.length > 0 || before.merging) {
          return { ...before, outcome: "conflict" };
        }
        await snapshotBeforeSync();
        const fetch = await tryGit(["fetch", "--prune", "origin"]);
        if (fetch.code !== 0) {
          throw new CommonsSyncError(
            `Could not fetch the Commons remote: ${safeGitError(fetch)}`,
          );
        }
        const branch = await currentBranch();
        if (branch === undefined) {
          throw new CommonsSyncError("The Commons is not on a named branch.");
        }
        const upstream = await remoteBranch(branch);
        if (upstream === null) {
          return { ...(await readSyncStatus()), outcome: "up-to-date" };
        }
        // An older Commons may already be on `master` while a newly created
        // remote uses `main`. Track the branch we actually merged so the next
        // push updates it instead of silently creating a second remote line.
        const tracking = await tryGit([
          "branch",
          `--set-upstream-to=origin/${upstream}`,
          branch,
        ]);
        if (tracking.code !== 0) {
          throw new CommonsSyncError(
            `Could not track the Commons remote branch: ${safeGitError(tracking)}`,
          );
        }
        const merged = await tryGit([
          "-c",
          `user.name=${COMMONS_AUTHOR_NAME}`,
          "-c",
          `user.email=${COMMONS_AUTHOR_EMAIL}`,
          "merge",
          "--no-edit",
          "--allow-unrelated-histories",
          `origin/${upstream}`,
        ]);
        const status = await readSyncStatus();
        if (merged.code !== 0) {
          if (status.conflicts.length > 0) {
            return { ...status, outcome: "conflict" };
          }
          throw new CommonsSyncError(
            `Could not merge the Commons remote: ${safeGitError(merged)}`,
            409,
          );
        }
        const unchanged = /already up[ -]to[ -]date/i.test(
          `${merged.stdout} ${merged.stderr}`,
        );
        return { ...status, outcome: unchanged ? "up-to-date" : "pulled" };
      });
    },

    async push(): Promise<CommonsSyncResult> {
      return exclusive(async () => {
        await requireRemote();
        const status = await readSyncStatus();
        if (status.conflicts.length > 0 || status.merging) {
          return { ...status, outcome: "conflict" };
        }
        await snapshotBeforeSync();
        const fetch = await tryGit(["fetch", "--prune", "origin"]);
        if (fetch.code !== 0) {
          throw new CommonsSyncError(
            `Could not fetch the Commons remote: ${safeGitError(fetch)}`,
          );
        }
        const branch = await currentBranch();
        if (branch === undefined) {
          throw new CommonsSyncError("The Commons is not on a named branch.");
        }
        const target = (await remoteBranch(branch)) ?? branch;
        const pushed = await tryGit([
          "push",
          "--set-upstream",
          "origin",
          `HEAD:refs/heads/${target}`,
        ]);
        if (pushed.code !== 0) {
          throw new CommonsSyncError(
            "The Commons could not be pushed. Pull first if the remote has " +
              `new work. ${safeGitError(pushed)}`,
            409,
          );
        }
        return { ...(await readSyncStatus()), outcome: "pushed" };
      });
    },

    async continueSync(): Promise<CommonsSyncResult> {
      return exclusive(async () => {
        const status = await readSyncStatus();
        if (!status.merging && status.conflicts.length === 0) {
          return { ...status, outcome: "up-to-date" };
        }
        const markers = await markerConflicts(status.conflicts);
        if (markers.length > 0) {
          return { ...status, conflicts: markers, outcome: "conflict" };
        }
        const staged = await tryGit(["add", "-A"]);
        if (staged.code !== 0) {
          throw new CommonsSyncError(
            `Could not stage the resolved Commons: ${safeGitError(staged)}`,
          );
        }
        const remaining = await conflictPaths();
        if (remaining.length > 0) {
          return {
            ...(await readSyncStatus()),
            conflicts: remaining,
            outcome: "conflict",
          };
        }
        const committed = await tryGit([
          "-c",
          `user.name=${COMMONS_AUTHOR_NAME}`,
          "-c",
          `user.email=${COMMONS_AUTHOR_EMAIL}`,
          "commit",
          "--quiet",
          "--no-edit",
        ]);
        if (committed.code !== 0) {
          throw new CommonsSyncError(
            `Could not record the resolved Commons: ${safeGitError(committed)}`,
            409,
          );
        }
        return { ...(await readSyncStatus()), outcome: "resolved" };
      });
    },
  };
}

/**
 * A title to an id, or a refusal a caller can put in a 400.
 *
 * `slugify` answers `null` rather than inventing `untitled-4`, and this turns
 * that into the sentence a user should read: the caller is being asked for an
 * explicit id, not told that their title was wrong.
 */
function slugFor(title: string): string {
  const slug = slugify(title);
  if (slug === null) {
    throw new CommonsError(
      `No filename can be derived from "${title}". Pass an explicit "id".`,
    );
  }
  return slug;
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function redactRemote(remote: string): string {
  return remote.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1***@");
}

function safeGitError(result: { stdout: string; stderr: string }): string {
  return redactRemote(
    result.stderr.trim() || result.stdout.trim() || "Git failed.",
  );
}
