/**
 * Projects — the codebases Cuesheet knows about.
 *
 * Until now Cuesheet had no concept of one. `startDaemon` took a single `cwd`,
 * `loadConfig` walked two fixed candidates, and the run store had one root, so
 * "the project" was wherever the process happened to be standing. In the
 * packaged app that is worse than it sounds: the Electron main process never
 * calls `chdir`, so a double-clicked `.app` resolves `process.cwd()` to `/` and
 * the first config candidate can never match. This file is the beginning of
 * fixing that (Step 31); the daemon does not consume it yet (Step 32).
 *
 * Four decisions are baked in here, and each one is a fork someone would
 * otherwise take the other way:
 *
 * - **An id is assigned once, not derived from the path.** Deriving it would
 *   make `open()` idempotent for free, but it also means renaming a folder
 *   silently mints a *different* project — orphaning its run history at the
 *   moment a user is least expecting to lose anything. So the id is stable and
 *   the root is mutable data, and idempotency comes from the next decision
 *   instead.
 * - **Identity is the resolved root.** `open()` resolves through `realpath`
 *   before looking for a match, because a path and a symlink to it are the same
 *   project and must not become two. This repo has already paid for that lesson
 *   once — `observe.ts` exists because a workspace under `/tmp` sees its own
 *   writes arrive as `/private/tmp/...` on macOS — and the same asymmetry would
 *   otherwise duplicate an entry every time someone opened a linked checkout.
 * - **Stored roots are compared, never re-resolved.** A project whose folder has
 *   been deleted cannot be `realpath`ed; doing so at compare time would throw
 *   `ENOENT` on precisely the case {@link ProjectRegistry.list} exists to
 *   report calmly.
 * - **Config is referenced, never copied in.** A registry entry carries where a
 *   project is, not what its config says. Persisting parsed config here would
 *   create a second source of truth that disagrees with `cuesheet.toml` the
 *   moment anyone edits it by hand.
 */
import {
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
// Deliberately the *ambient* `node:path`, not `pathFor(env)`.
//
// `pathFor` exists so that pure string math can be tested for a platform the
// test is not running on. But `node:fs` is bound to the real host, so any path
// handed to it has to be built by the real host's path module — resolving a
// POSIX path with `path.win32` produces backslashes that the filesystem
// underneath then cannot find. The split is: `pathFor(env)` for layout and for
// strings, `nodePath` for anything that reaches disk.
import nodePath from "node:path";
import {
  hostEnv,
  isProjectId,
  isWindows,
  pathFor,
  projectsFile,
  type HostEnv,
  type ProjectId,
} from "./paths.js";

/** The registry file's schema version. Bumped when the shape changes. */
export const PROJECT_REGISTRY_VERSION = 1;

export interface Project {
  readonly id: ProjectId;
  /** Display name. Defaults to the folder's own name; the user may change it. */
  readonly name: string;
  /** Absolute, `realpath`-resolved at the time the project was first opened. */
  readonly root: string;
  readonly addedAt: string;
  /** `null` until the project has been opened at least once after being added. */
  readonly lastOpenedAt: string | null;
}

/**
 * `missing` means the root is not a directory we can see right now.
 *
 * There is deliberately no `moved` state. Without tracking inodes across
 * platforms — which Windows makes its own project — a renamed folder and a
 * deleted one are indistinguishable, and a picker that claimed to tell them
 * apart would be guessing at the user.
 */
export type ProjectStatus = "ok" | "missing";

export type ListedProject = Project & { readonly status: ProjectStatus };

export class ProjectRegistryError extends Error {
  readonly path: string;
  constructor(message: string, path: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProjectRegistryError";
    this.path = path;
  }
}

export interface ProjectRegistry {
  /** Newest-opened first — the order a picker wants. */
  list(): Promise<ListedProject[]>;
  get(id: string): Promise<Project | null>;
  /**
   * Add the folder if it is new, mark it opened either way, and make it the
   * one {@link lastOpened} answers with.
   */
  open(root: string, options?: OpenOptions): Promise<Project>;
  rename(id: string, name: string): Promise<Project>;
  /** Forget the entry. Never touches the folder itself. Returns whether it existed. */
  forget(id: string): Promise<boolean>;
  /** The project to reopen on launch, or `null` on a fresh install. */
  lastOpened(): Promise<Project | null>;
}

export interface OpenOptions {
  /** Overrides the folder-derived display name. */
  name?: string;
  /** Injectable clock, so tests can assert ordering without sleeping. */
  now?: Date;
}

export interface ProjectRegistryOptions {
  env?: HostEnv;
  /** Override the registry file outright. Wins over `env`. */
  file?: string;
}

interface RegistryFile {
  version: number;
  lastOpenedId: string | null;
  projects: Project[];
}

const EMPTY: RegistryFile = {
  version: PROJECT_REGISTRY_VERSION,
  lastOpenedId: null,
  projects: [],
};

/**
 * Turn a folder name into the readable half of an id.
 *
 * Readability is the whole point: these become directory names in a tree the
 * README promises you can "read it, grep it, diff it", and `api-3f2a1b` tells
 * you something that a bare hash does not.
 */
export function slugForRoot(root: string, env: HostEnv = hostEnv()): string {
  const base = pathFor(env).basename(root);
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  // A root of `/`, or a folder named entirely in a non-Latin script, slugs to
  // nothing. The id still has to be a valid path segment, so it gets a noun.
  return slug === "" ? "project" : slug;
}

/** `api` → `api-3f2a1b`. The suffix is random, never derived from the path. */
export function mintProjectId(
  root: string,
  env: HostEnv = hostEnv(),
  suffix = randomBytes(3).toString("hex"),
): ProjectId {
  return `${slugForRoot(root, env)}-${suffix}`;
}

/**
 * One rule for a display name, applied at both entry points.
 *
 * `rename()` trimmed and rejected empty from the start; `open({ name })` wrote
 * whatever it was handed. Two writers of one field with two sets of rules is
 * how a project ends up called `"   "`.
 */
function cleanName(name: string, file: string): string {
  const trimmed = name.trim();
  if (trimmed === "") {
    throw new ProjectRegistryError("A project name cannot be empty.", file);
  }
  return trimmed;
}

/**
 * Windows compares paths case-insensitively, so two entries differing only in
 * case are one folder and must not become two projects.
 */
function sameRoot(a: string, b: string, env: HostEnv): boolean {
  return isWindows(env) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The registry, backed by one JSON file.
 *
 * Two properties it has to hold, both learned elsewhere in this codebase:
 *
 * - **Writes are serialized through one promise chain.** Every mutation is a
 *   read-modify-write of a single file, which is the same race `store.ts`
 *   serializes per-run — and two windows opening two projects at once is a
 *   realistic way to trigger it rather than a theoretical one.
 * - **Written temp-then-rename.** A same-directory rename is atomic on both
 *   platforms, so a crash mid-write leaves the previous list rather than half
 *   of a new one.
 *
 * **The chain is in-process, and that is only sufficient because the daemon is
 * the sole writer.** Phase 8 commits to one daemon serving many projects, with
 * every other surface a client of it; two *processes* would both rename over
 * the target and the later one would win, losing an update that no promise
 * chain can see. `projects.json` sits at a well-known path, so anything tempted
 * to write it directly — the `cuesheet` CLI of Step 51, most obviously — goes
 * through the daemon instead, or this needs a real lock first.
 */
export function createProjectRegistry(
  options: ProjectRegistryOptions = {},
): ProjectRegistry {
  const env = options.env ?? hostEnv();
  const file = options.file ?? projectsFile(env);
  let chain: Promise<unknown> = Promise.resolve();

  /** Run `fn` after every mutation already queued, whether or not those threw. */
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  }

  async function read(): Promise<RegistryFile> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (cause) {
      if (isNotFound(cause)) return { ...EMPTY, projects: [] };
      throw new ProjectRegistryError(
        `Could not read ${file}: ${errorText(cause)}`,
        file,
        { cause },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripBom(text));
    } catch (cause) {
      // Deliberately *not* the same answer `config.ts` gives a broken file.
      // That one throws because an empty Desk would hide a typo; this one
      // throws because silently starting from an empty list would discard
      // somebody's projects, and the beta bar says no data loss, ever. Same
      // verb, opposite reason — and in both cases the file is left alone.
      throw new ProjectRegistryError(
        `${file} is not valid JSON, so the project list cannot be read. ` +
          `It has been left untouched — fix or move it. (${errorText(cause)})`,
        file,
        { cause },
      );
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new ProjectRegistryError(
        `${file} is not a project registry. It has been left untouched.`,
        file,
      );
    }

    const raw = parsed as Partial<RegistryFile>;
    const version = typeof raw.version === "number" ? raw.version : 0;
    if (version > PROJECT_REGISTRY_VERSION) {
      // Refusing here costs three lines; truncating costs somebody their list
      // the first time they open an older build after a newer one.
      throw new ProjectRegistryError(
        `${file} was written by a newer version of Cuesheet ` +
          `(registry v${String(version)}, this build reads v${String(PROJECT_REGISTRY_VERSION)}). ` +
          `Upgrade rather than downgrade; nothing has been changed.`,
        file,
      );
    }

    return {
      version,
      lastOpenedId:
        typeof raw.lastOpenedId === "string" ? raw.lastOpenedId : null,
      projects: Array.isArray(raw.projects)
        ? raw.projects.filter(isStoredProject)
        : [],
    };
  }

  async function write(next: RegistryFile): Promise<void> {
    await mkdir(nodePath.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid.toString(36)}.tmp`;
    const body = JSON.stringify(
      { ...next, version: PROJECT_REGISTRY_VERSION },
      null,
      2,
    );
    await writeFile(temp, `${body}\n`, "utf8");
    await rename(temp, file);
  }

  async function mutate<T>(
    fn: (
      state: RegistryFile,
    ) =>
      | Promise<{ state: RegistryFile; result: T }>
      | { state: RegistryFile; result: T },
  ): Promise<T> {
    return serialize(async () => {
      const state = await read();
      const { state: next, result } = await fn(state);
      await write(next);
      return result;
    });
  }

  return {
    async list() {
      const { projects } = await read();
      const listed = await Promise.all(
        projects.map(async (project) => ({
          ...project,
          status: ((await isDirectory(project.root))
            ? "ok"
            : "missing") as ProjectStatus,
        })),
      );
      return listed.sort(byRecency);
    },

    async get(id) {
      const { projects } = await read();
      return projects.find((project) => project.id === id) ?? null;
    },

    async lastOpened() {
      const { projects, lastOpenedId } = await read();
      if (lastOpenedId === null) return null;
      return projects.find((project) => project.id === lastOpenedId) ?? null;
    },

    async open(root, openOptions = {}) {
      // Resolved *before* the read, so a symlinked path and its target are one
      // project. A root that does not exist cannot be opened at all — that is
      // a different failure from a project whose folder went away later, and
      // it deserves a different message.
      let resolved: string;
      try {
        resolved = await realpath(nodePath.resolve(root));
      } catch (cause) {
        throw new ProjectRegistryError(
          `Cannot open ${root}: no such folder.`,
          file,
          { cause },
        );
      }
      if (!(await isDirectory(resolved))) {
        throw new ProjectRegistryError(
          `Cannot open ${root}: it is a file, not a folder.`,
          file,
        );
      }

      const at = (openOptions.now ?? new Date()).toISOString();
      return mutate((state) => {
        const existing = state.projects.find((project) =>
          sameRoot(project.root, resolved, env),
        );
        const project: Project = existing
          ? { ...existing, lastOpenedAt: at }
          : {
              id: uniqueId(state, resolved, env),
              name:
                openOptions.name === undefined
                  ? slugForRoot(resolved, env)
                  : cleanName(openOptions.name, file),
              root: resolved,
              addedAt: at,
              lastOpenedAt: at,
            };
        return {
          state: {
            ...state,
            lastOpenedId: project.id,
            projects: replace(state.projects, project),
          },
          result: project,
        };
      });
    },

    async rename(id, name) {
      const trimmed = cleanName(name, file);
      return mutate((state) => {
        const existing = state.projects.find((project) => project.id === id);
        if (!existing) {
          throw new ProjectRegistryError(`No project with id "${id}".`, file);
        }
        const project: Project = { ...existing, name: trimmed };
        return {
          state: { ...state, projects: replace(state.projects, project) },
          result: project,
        };
      });
    },

    async forget(id) {
      return mutate((state) => {
        const projects = state.projects.filter((project) => project.id !== id);
        return {
          state: {
            ...state,
            projects,
            lastOpenedId: state.lastOpenedId === id ? null : state.lastOpenedId,
          },
          result: projects.length !== state.projects.length,
        };
      });
    },
  };
}

/**
 * Most recently opened first; never-opened projects fall back to when they were
 * added.
 *
 * Plain comparison rather than `localeCompare`, which applies collation rules
 * that can treat `-` as ignorable — on ISO-8601 strings, lexical order *is*
 * chronological order, the same property run ids are built around.
 */
function byRecency(a: Project, b: Project): number {
  const left = a.lastOpenedAt ?? a.addedAt;
  const right = b.lastOpenedAt ?? b.addedAt;
  if (left === right) return 0;
  return left < right ? 1 : -1;
}

/**
 * Replace in place, append only when new.
 *
 * Moving a touched entry to the end would re-order `projects.json` on every
 * open, turning a one-field change into a whole-file diff — against a README
 * that promises you can "read it, grep it, diff it". Display order is
 * {@link byRecency}'s job, not the file's.
 */
function replace(projects: Project[], project: Project): Project[] {
  const index = projects.findIndex((each) => each.id === project.id);
  if (index === -1) return [...projects, project];
  return projects.map((each, at) => (at === index ? project : each));
}

/**
 * Mint an id that no entry already holds.
 *
 * A six-hex-digit suffix collides about as often as you would expect, which is
 * to say almost never — but "almost never" across every user forever is not the
 * same as never, and a collision here would mean two projects sharing one
 * directory under `~/.cuesheet/projects`.
 */
function uniqueId(state: RegistryFile, root: string, env: HostEnv): ProjectId {
  const taken = new Set(state.projects.map((project) => project.id));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = mintProjectId(root, env);
    if (!taken.has(id)) return id;
  }
  throw new ProjectRegistryError("Could not mint a unique project id.", root);
}

function isStoredProject(value: unknown): value is Project {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Partial<Project>;
  return (
    isProjectId(p.id) &&
    typeof p.name === "string" &&
    typeof p.root === "string" &&
    typeof p.addedAt === "string" &&
    (p.lastOpenedAt === null || typeof p.lastOpenedAt === "string")
  );
}

/**
 * The BOM lesson from `parseConfig`, applied before it costs a second day:
 * a file written by a Windows tool can start with U+FEFF, and `JSON.parse`
 * rejects it.
 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function isNotFound(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code?: string }).code === "ENOENT"
  );
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
