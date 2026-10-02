/**
 * The one glob matcher in the product.
 *
 * It used to be private to `leash.ts`, and moved here in Step 58 when Gates
 * needed to match paths too. Not a tidy-up: two glob implementations in one
 * product will eventually disagree, and the one that disagrees about
 * `infra/**` is a security bug. So the leash and the Gate's `always_review` /
 * `never_review` rules compile through exactly this function.
 *
 * It lives in its own module rather than staying in `leash.ts` because that
 * module imports `node:fs/promises` for `resolveAndCheck`, and `gate.ts` is
 * deliberately free of disk. For the same reason the platform test below is
 * written inline rather than imported from `paths.ts`, which reaches
 * `node:path` and `node:os` at load time.
 */
import picomatch from "picomatch";
import type { HostEnv } from "./paths.js";

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
  return { dot: true, nocase: env.platform === "win32" };
}

/**
 * Compile one rule into a matcher over a **workspace-relative posix** path.
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
export function compileGlob(
  glob: string,
  env: HostEnv,
): (relPosix: string) => boolean {
  const options = matchOptions(env);
  if (picomatch.scan(glob).isGlob) return picomatch(glob, options);

  const bare = glob.replace(/\/+$/, "");
  return picomatch([bare, `${bare}/**`], options);
}

/** The first rule in `globs` that matches, or `undefined`. */
export function firstMatch(
  globs: readonly string[],
  relPosix: string,
  env: HostEnv,
): string | undefined {
  return globs.find((glob) => compileGlob(glob, env)(relPosix));
}
