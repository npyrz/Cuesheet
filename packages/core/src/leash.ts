/**
 * Leash enforcement — the check that lives in the daemon, not in a prompt.
 *
 * The README's promise is specific: "A Station denied `infra/**` cannot write
 * there even if the model decides it should." That only holds if this file is
 * the single chokepoint, so it is written to be exhaustively testable from
 * either OS: no ambient `process.platform`, no ambient `node:path`, and no I/O.
 *
 * The I/O that the check *does* need — resolving symlinks, which are the
 * obvious way out of a workspace — is deliberately not in here. It lives in
 * `resolveAndCheck` below, a thin async wrapper, so the decision logic stays a
 * pure function that a test can hammer with hostile inputs.
 */
import { realpath } from "node:fs/promises";
import picomatch from "picomatch";
import {
  expandHome,
  hostEnv,
  isWindows,
  pathFor,
  toPosix,
  type HostEnv,
} from "./paths.js";
import type { Station } from "./config.js";

export interface LeashDecision {
  allowed: boolean;
  /** Present whenever `allowed` is false. Recorded on the Run as a denial. */
  reason?: string;
  /** Which deny glob matched, when one did. */
  rule?: string;
}

/** The parts of a Station the leash cares about. */
export interface Leash {
  workspace: string;
  paths?: readonly string[] | undefined;
  deny?: readonly string[] | undefined;
}

/**
 * Match options, and why each one is not a default.
 *
 * `dot: true` — without it picomatch will not let `*` cross a leading dot, so
 * the README's own deny rule `**\/*.env` fails to match a bare `.env`, the
 * exact file the rule exists to protect. A test using `config.env` passes
 * either way, which is how this ships broken.
 *
 * `nocase` is gated on the platform rather than always on. On Windows
 * `SECRET.ENV` and `secret.env` are the same file, and `path.relative` folds
 * case for its own comparison but hands back the target's original spelling —
 * so a case-sensitive match lets a renamed `.env` straight past a deny rule.
 * On POSIX a directory can genuinely hold both, and folding there would deny
 * files the user never wrote a rule for.
 */
function matchOptions(env: HostEnv): picomatch.PicomatchOptions {
  return { dot: true, nocase: isWindows(env) };
}

export function toLeash(station: Station): Leash {
  return {
    workspace: station.workspace ?? "",
    paths: station.paths,
    deny: station.deny,
  };
}

/**
 * Decide whether a Station may touch a path.
 *
 * Order, and each step matters:
 *   1. No workspace configured → deny. An unbound Station touches nothing.
 *   2. Resolve both sides to absolute, expanding `~`.
 *   3. Containment via `path.relative`, never a string prefix — `/wsX` has
 *      `/ws` as a prefix but is a different directory, and `../` escapes look
 *      like ordinary paths until they are resolved.
 *   4. Deny globs, which beat everything.
 *   5. Allow globs; absent or empty means deny, because the default is deny.
 *
 * Globs match the **workspace-relative posix** path. Matching the absolute one
 * would mean `src/**` never matches anything, and would make every rule
 * depend on where the workspace happens to live.
 */
export function checkPath(
  station: Station | Leash,
  targetPath: string,
  env: HostEnv = hostEnv(),
): LeashDecision {
  const leash = "role" in station ? toLeash(station) : station;
  const p = pathFor(env);

  if (!leash.workspace) {
    return {
      allowed: false,
      reason: "Station has no workspace; nothing is in reach.",
    };
  }

  const workspace = p.resolve(expandHome(leash.workspace, env));
  const target = p.resolve(workspace, expandHome(targetPath, env));

  const rel = p.relative(workspace, target);

  // `""` is the workspace directory itself — not a file, and not writable as one.
  if (rel === "") {
    return {
      allowed: false,
      reason: "Path is the workspace root itself, not a file inside it.",
    };
  }

  // `..` catches an escape upward; `isAbsolute` catches a different Windows
  // drive, where `relative("C:\\a", "D:\\b")` returns `D:\b` — no leading `..`
  // at all, so a `..`-only check would let a whole other volume through.
  if (rel.startsWith("..") || p.isAbsolute(rel)) {
    return {
      allowed: false,
      reason: `Path escapes the workspace (${leash.workspace}).`,
    };
  }

  const relPosix = toPosix(rel, env);

  for (const glob of leash.deny ?? []) {
    if (compile(glob, env)(relPosix)) {
      return {
        allowed: false,
        reason: `Denied by leash rule "${glob}".`,
        rule: glob,
      };
    }
  }

  const allow = leash.paths ?? [];
  if (allow.length === 0) {
    return {
      allowed: false,
      reason: "Station has no allowed paths; the leash defaults to deny.",
    };
  }

  for (const glob of allow) {
    if (compile(glob, env)(relPosix)) return { allowed: true };
  }

  return {
    allowed: false,
    reason: `Path is outside the Station's allowed paths (${allow.join(", ")}).`,
  };
}

/**
 * Compile one leash rule into a matcher.
 *
 * A rule with no glob syntax in it — `paths = ["src/config"]` — is expanded to
 * cover the directory *and* its contents. Written literally it would match one
 * path and nothing under it, which is never what someone naming a directory
 * means.
 *
 * There is deliberately no walk-up over ancestor directories here. That looks
 * like a convenience and is actually a bypass: applied to an allow list it
 * turns `src/*` into `src/**`, because `src/deep/nested/secret.ts` has an
 * ancestor `src/deep` that `src/*` matches. A rule that says one level deep
 * has to mean one level deep.
 */
function compile(glob: string, env: HostEnv): (relPosix: string) => boolean {
  const options = matchOptions(env);
  if (picomatch.scan(glob).isGlob) return picomatch(glob, options);

  const bare = glob.replace(/\/+$/, "");
  const isMatch = picomatch([bare, `${bare}/**`], options);
  return isMatch;
}

/**
 * `checkPath`, with symlinks resolved first.
 *
 * This is the entry point real callers should use. A symlink inside the
 * workspace pointing at `/etc` passes a purely lexical containment check, so
 * the leash is only as strong as this call.
 *
 * `realpath` is attempted on the target and, failing that (the file does not
 * exist yet — the common case for a write), on its nearest existing ancestor.
 * A path that cannot be resolved at all is checked lexically rather than
 * allowed: unresolvable is not the same as safe, but neither is it a reason to
 * deny a legitimate new file.
 */
export async function resolveAndCheck(
  station: Station | Leash,
  targetPath: string,
  env: HostEnv = hostEnv(),
): Promise<LeashDecision> {
  const leash = "role" in station ? toLeash(station) : station;
  const p = pathFor(env);

  if (!leash.workspace) return checkPath(leash, targetPath, env);

  const workspace = await realpathOrSelf(
    p.resolve(expandHome(leash.workspace, env)),
  );
  const target = p.resolve(workspace, expandHome(targetPath, env));
  const resolvedTarget = await realpathDeepest(target, p);

  return checkPath({ ...leash, workspace }, resolvedTarget, env);
}

async function realpathOrSelf(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch {
    return candidate;
  }
}

/**
 * Resolve the longest existing prefix of `candidate` and re-attach the rest.
 *
 * Resolving only the whole path would silently give up on any file that does
 * not exist yet, which is exactly when a write is being checked — and a
 * symlinked *parent* directory is the escape that matters.
 */
async function realpathDeepest(
  candidate: string,
  p: ReturnType<typeof pathFor>,
): Promise<string> {
  const tail: string[] = [];
  let cursor = candidate;

  for (;;) {
    try {
      const resolved = await realpath(cursor);
      return tail.length ? p.join(resolved, ...tail.reverse()) : resolved;
    } catch {
      const parent = p.dirname(cursor);
      if (parent === cursor) return candidate;
      tail.push(p.basename(cursor));
      cursor = parent;
    }
  }
}
