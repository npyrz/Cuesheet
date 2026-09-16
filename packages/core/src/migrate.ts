/**
 * The upgrade that loses nothing — Step 33.
 *
 * An alpha install has one `~/.cuesheet/cuesheet.toml` and one flat
 * `~/.cuesheet/runs` of history, written by a build that had never heard of a
 * project. Step 32 gave the daemon a registry and a store root per project and
 * left this seam open on purpose: it bootstrapped such a user into a project
 * rooted at `~/.cuesheet`, which is not where their code is, and left their run
 * history where the new store would never look for it. Both are this file.
 *
 * **Nothing here deletes or rewrites anything.** Every operation is a
 * same-filesystem `rename` inside `~/.cuesheet`, so the bytes of a config and
 * of every `run.json` survive the move exactly — which is also what makes "still
 * attributed" true for free: `workspace` and `stationIds` are fields of a file
 * that is never reopened.
 *
 * **Each move guards on its own target being absent**, so the whole migration
 * is idempotent and, for runs, retried on the next boot if it ever fails. That
 * is deliberately not a marker file: a marker is a third thing that can
 * disagree with the two it describes, and "has the destination arrived yet" is
 * already the question a marker would be answering.
 */
import { mkdir, readdir, rename, realpath, stat } from "node:fs/promises";
// The ambient `node:path`, not `pathFor(env)` — see the note in `project.ts`.
// `pathFor` builds strings for a platform the test is not running on; `node:fs`
// is bound to the real host, and a POSIX path resolved with `path.win32` yields
// backslashes the filesystem underneath cannot find.
import nodePath from "node:path";
import {
  CONFIG_FILENAME,
  configDir,
  configFile,
  expandHome,
  hostEnv,
  isWindows,
  projectConfigFile,
  projectRunsDir,
  runsDir,
  type HostEnv,
} from "./paths.js";
import type { LoadedConfig } from "./config.js";

/** What a migration step did, for the daemon to log. `null` means "nothing to do". */
export interface Relocation {
  readonly from: string;
  readonly to: string;
}

/**
 * Where to root the project an existing install comes back up on.
 *
 * Two cases, and only the second is a judgement call:
 *
 * - **The config sits in a repo** (`<somewhere>/cuesheet.toml`). That folder is
 *   the project, full stop. This is what Step 32 already did and it was already
 *   right, so nothing here touches it.
 * - **The config is the global `~/.cuesheet/cuesheet.toml`.** Rooting the
 *   project at `~/.cuesheet` — Step 32's answer — puts a dot-directory in the
 *   picker where the user expects their repository. The only evidence on disk
 *   about where their code actually is is the Stations' `workspace` fields, so
 *   that is what is read.
 *
 * **The derivation refuses to guess, and the discriminator is shadowing rather
 * than plausibility.** `projectConfigSearchPaths` prefers `<root>/cuesheet.toml`
 * over the private fallback — by design, because a repo-committed config is what
 * a team sharing Stations wants. So rooting a migrated project at a folder that
 * already has a `cuesheet.toml` would hand that file the project and make every
 * alpha Station silently disappear from the Desk. That is the beta bar's own
 * failure mode, not a cosmetic one. A derived root is therefore accepted only
 * when the Stations agree on exactly one existing directory *and* that
 * directory has no config of its own; anything else stays at `~/.cuesheet`,
 * where the legacy file remains the first candidate and stays live.
 *
 * Returns `null` when there is no config anywhere — a fresh install has no
 * project, and inventing one would put a folder in the picker nobody chose.
 */
export async function legacyProjectRoot(
  loaded: LoadedConfig,
  env: HostEnv = hostEnv(),
): Promise<string | null> {
  if (loaded.sourcePath === null) return null;

  const home = configFile(env);
  const source = nodePath.dirname(loaded.sourcePath);
  if (loaded.sourcePath !== home) return source;

  const derived = await unanimousWorkspace(loaded, env);
  return derived ?? configDir(env);
}

/**
 * The one directory every Station points at, or `null` if they disagree.
 *
 * Stations without a `workspace` are ignored rather than counted against
 * agreement: the field is optional, and a config of two Stations where one names
 * the repo and the other inherits it is one project by any reading.
 *
 * `realpath` before comparing, for the reason `observe.ts` exists — on macOS a
 * workspace written as `/tmp/api` arrives as `/private/tmp/api`, and two
 * spellings of one folder would read as disagreement.
 */
async function unanimousWorkspace(
  loaded: LoadedConfig,
  env: HostEnv,
): Promise<string | null> {
  const roots = new Set<string>();
  for (const station of loaded.config.station) {
    if (station.workspace === undefined) continue;
    try {
      const resolved = await realpath(
        nodePath.resolve(expandHome(station.workspace, env)),
      );
      if (!(await isDirectory(resolved))) return null;
      roots.add(resolved);
    } catch {
      // A workspace that is not on disk is no evidence about where the code
      // is. It is also not a disagreement — an alpha config can name a
      // checkout that has since moved — so it is skipped, and unanimity is
      // decided by the Stations that can still be believed.
      //
      // The asymmetry with the `isDirectory` check above is deliberate, and
      // both halves fail conservatively: a path that cannot be resolved is
      // *missing* evidence, while a workspace that resolves to a file is
      // *wrong* evidence, and a config that wrong is not one to derive a
      // project root from at all.
      continue;
    }
  }

  if (roots.size !== 1) return null;
  const [root] = [...roots];
  if (root === undefined) return null;
  // The shadowing guard. See the note on `legacyProjectRoot`.
  if (await exists(nodePath.join(root, CONFIG_FILENAME))) return null;
  return root;
}

/**
 * Move `~/.cuesheet/cuesheet.toml` to the migrated project's private config.
 *
 * Needed only when {@link legacyProjectRoot} derived a root *away* from
 * `~/.cuesheet`: the new search path is
 * `[<root>/cuesheet.toml, ~/.cuesheet/projects/<id>/cuesheet.toml]`, and the
 * legacy file is in neither. Left where it is, the project would come up on
 * built-in defaults and the user's Stations would be gone — the exact loss this
 * step is named for.
 *
 * **`sourcePath` is a parameter rather than something inferred from `root`, and
 * that distinction is a bug this function already had.** The first draft asked
 * "is this project rooted somewhere other than `~/.cuesheet`?" and treated yes
 * as "then the global config must be its config." It is not: a user can have a
 * `cuesheet.toml` in their repo *and* a leftover global one — alpha's
 * `addStation` wrote the global file whenever the loader found nothing, which is
 * what a Finder-launched app always got. Such a user is rooted at their repo,
 * so the old guard passed, and their global config was relocated under a project
 * whose repo config shadows it: moved somewhere nothing would ever read it
 * again. The honest question is whether the legacy file is *the config this
 * project is actually loading*, and only the loader can answer that.
 *
 * **Moved, not copied.** A copy leaves two files that are the same until the
 * first edit and then quietly are not; `addStation` writes to whichever one the
 * loader returned, so the other becomes a stale config sitting at a path the
 * next fresh-registry bootstrap would read. The private fallback is the
 * documented home for a config whose repo does not carry one, so this is the
 * file arriving where it now belongs rather than being duplicated toward it.
 *
 * The cost, recorded rather than discovered: an alpha build downgraded to after
 * this runs will not find its config. Upgrades keep everything; downgrades were
 * never promised, and the registry already refuses to be read by an older build.
 */
export async function migrateLegacyConfig(options: {
  projectId: string;
  root: string;
  /** The file the loader actually resolved for this install. */
  sourcePath: string | null;
  env?: HostEnv;
}): Promise<Relocation | null> {
  const env = options.env ?? hostEnv();
  const from = configFile(env);

  // Not this project's config, so not this project's to move. An exact compare
  // is right here and not a Windows hazard: both strings come out of the same
  // `pathFor(env).join(configDir(env), CONFIG_FILENAME)` expression, one via
  // `configSearchPaths` and one via `configFile`.
  if (options.sourcePath !== from) return null;

  // Already the first candidate for this project — which is the whole of the
  // `~/.cuesheet`-rooted case, and says so in terms of the search path rather
  // than by naming a directory. Moving a live config out of its own search
  // path would be this function causing the loss it exists to prevent.
  if (samePath(nodePath.join(options.root, CONFIG_FILENAME), from, env)) {
    return null;
  }

  const to = projectConfigFile(options.projectId, env);
  if (!(await exists(from))) return null;
  // Absent-target guard, which also makes this idempotent. A project that
  // already has a private config is one somebody has edited through the Desk,
  // and overwriting it with an older file is the loss running backwards.
  if (await exists(to)) return null;

  await mkdir(nodePath.dirname(to), { recursive: true });
  await rename(from, to);
  return { from, to };
}

/**
 * Move `~/.cuesheet/runs` to `~/.cuesheet/projects/<id>/runs`.
 *
 * A directory rename, which Step 32 chose the per-project store root partly to
 * make possible: run ids are timestamp-prefixed, `list()` answers off `readdir`
 * alone, and the whole history relocates as one atomic operation rather than
 * being copied record by record into a shape that could half-arrive.
 *
 * **The caller must do this before the project's runtime is built.** A runtime
 * reconciles its store on first touch, and a reconcile over an empty store
 * leaves every alpha run that a killed daemon left `running` marked `running`
 * forever — nothing reconciles a store twice, so that lie would never be
 * corrected.
 *
 * **If the rename fails, nothing is lost and nothing is registered as done:**
 * the history is still at `~/.cuesheet/runs`, the target is still absent, and
 * the guards above bring the daemon back to this same call on the next boot.
 * That is why the caller logs and continues rather than refusing to boot.
 */
export async function migrateLegacyRuns(options: {
  projectId: string;
  env?: HostEnv;
}): Promise<Relocation | null> {
  const env = options.env ?? hostEnv();
  const from = runsDir(env);
  const to = projectRunsDir(options.projectId, env);

  if (!(await isDirectory(from))) return null;
  if (await exists(to)) return null;
  // An empty legacy directory is not history; moving it would only make the
  // daemon's log claim an upgrade that carried nothing.
  if ((await readdir(from)).length === 0) return null;

  await mkdir(nodePath.dirname(to), { recursive: true });
  await rename(from, to);
  return { from, to };
}

/**
 * Windows compares paths case-insensitively, so two spellings of one file are
 * one file. The same rule `sameRoot` applies in `project.ts`, and for the same
 * reason: `registry.open` stores a `realpath`-resolved root while `configDir`
 * is built from `env.homedir`, and those two can disagree in case alone.
 */
function samePath(a: string, b: string, env: HostEnv): boolean {
  return isWindows(env) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
