import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkPath, resolveAndCheck, type Leash } from "./leash.js";
import type { Station } from "./config.js";
import type { HostEnv } from "./paths.js";

const mac: HostEnv = { platform: "darwin", homedir: "/Users/noah" };
const win: HostEnv = { platform: "win32", homedir: "C:\\Users\\noah" };

/** The README's own example Station. */
const station: Station = {
  id: "opus",
  harness: "claude-code",
  role: "engineer",
  model: "opus",
  workspace: "~/code/api",
  paths: ["src/**", "tests/**"],
  deny: ["**/*.env", "infra/**"],
};

describe("workspace containment", () => {
  it("allows a file under an allowed path", () => {
    expect(
      checkPath(station, "/Users/noah/code/api/src/server.ts", mac),
    ).toEqual({
      allowed: true,
    });
  });

  it("resolves a relative path against the workspace", () => {
    expect(checkPath(station, "src/server.ts", mac).allowed).toBe(true);
  });

  it("catches a `..` escape that resolves outside the workspace", () => {
    const decision = checkPath(station, "src/../../secrets/id_rsa", mac);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/escapes the workspace/);
  });

  it("catches a `..` escape written as an absolute path", () => {
    expect(checkPath(station, "/Users/noah/.ssh/id_rsa", mac).allowed).toBe(
      false,
    );
  });

  it("is not fooled by a sibling directory sharing a name prefix", () => {
    // `/Users/noah/code/api-secrets` has `/Users/noah/code/api` as a string
    // prefix but is a different directory. A prefix check would allow it.
    const decision = checkPath(
      station,
      "/Users/noah/code/api-secrets/src/a.ts",
      mac,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/escapes the workspace/);
  });

  it("denies the workspace root itself", () => {
    expect(checkPath(station, "/Users/noah/code/api", mac).allowed).toBe(false);
  });

  it("denies a Station with no workspace", () => {
    const unbound: Station = { id: "x", harness: "codex", role: "reviewer" };
    const decision = checkPath(unbound, "/anywhere/a.ts", mac);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/no workspace/);
  });
});

describe("deny beats allow", () => {
  it("denies `**/*.env` inside an allowed `src/**`", () => {
    const decision = checkPath(
      station,
      "/Users/noah/code/api/src/config.env",
      mac,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.rule).toBe("**/*.env");
  });

  it("denies a bare dotfile `.env`, not just `something.env`", () => {
    // picomatch will not cross a leading dot without `dot: true`, so this is
    // the case that separates a working deny rule from one that only looks
    // like it works.
    expect(
      checkPath(station, "/Users/noah/code/api/src/.env", mac),
    ).toMatchObject({
      allowed: false,
      rule: "**/*.env",
    });
    expect(checkPath(station, "/Users/noah/code/api/.env", mac).allowed).toBe(
      false,
    );
  });

  it("does not fold case on POSIX, where the two really are different files", () => {
    const leash: Leash = {
      workspace: "/ws",
      paths: ["**"],
      deny: ["**/*.env"],
    };
    expect(checkPath(leash, "/ws/.env", mac).allowed).toBe(false);
    expect(checkPath(leash, "/ws/SECRET.ENV", mac).allowed).toBe(true);
  });

  it("denies a deny-globbed directory and everything under it", () => {
    expect(
      checkPath(station, "/Users/noah/code/api/infra/main.tf", mac),
    ).toMatchObject({ allowed: false, rule: "infra/**" });
    // The directory itself, too — otherwise `infra/**` is sidestepped by
    // targeting `infra`.
    expect(checkPath(station, "/Users/noah/code/api/infra", mac).allowed).toBe(
      false,
    );
  });
});

describe("glob precision", () => {
  it("does not let a one-level allow glob recurse", () => {
    // The ancestor walk-up this used to do turned `src/*` into `src/**`:
    // `src/deep/nested/secret.ts` has an ancestor `src/deep` that `src/*`
    // matches. A rule that says one level deep has to mean one level deep.
    const leash: Leash = { workspace: "/ws", paths: ["src/*"] };
    expect(checkPath(leash, "/ws/src/a.ts", mac).allowed).toBe(true);
    expect(checkPath(leash, "/ws/src/deep/nested/secret.ts", mac).allowed).toBe(
      false,
    );
  });

  it("expands a glob-free rule to cover the directory and its contents", () => {
    // `paths = ["src/config"]` matched literally would allow one path and
    // nothing under it, which is never what naming a directory means.
    const leash: Leash = { workspace: "/ws", paths: ["src/config"] };
    expect(checkPath(leash, "/ws/src/config", mac).allowed).toBe(true);
    expect(checkPath(leash, "/ws/src/config/db.ts", mac).allowed).toBe(true);
    expect(checkPath(leash, "/ws/src/other.ts", mac).allowed).toBe(false);
  });

  it("expands a glob-free deny rule the same way", () => {
    const leash: Leash = {
      workspace: "/ws",
      paths: ["**"],
      deny: ["infra"],
    };
    expect(checkPath(leash, "/ws/infra/main.tf", mac)).toMatchObject({
      allowed: false,
      rule: "infra",
    });
    expect(checkPath(leash, "/ws/infrastructure/main.tf", mac).allowed).toBe(
      true,
    );
  });
});

describe("default deny", () => {
  it("denies a path outside the allowed globs", () => {
    const decision = checkPath(
      station,
      "/Users/noah/code/api/docs/readme.md",
      mac,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/outside the Station's allowed paths/);
  });

  it("denies everything when `paths` is absent", () => {
    const noPaths: Leash = { workspace: "/ws" };
    const decision = checkPath(noPaths, "/ws/src/a.ts", mac);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/defaults to deny/);
  });

  it("denies everything when `paths` is empty", () => {
    expect(
      checkPath({ workspace: "/ws", paths: [] }, "/ws/a.ts", mac).allowed,
    ).toBe(false);
  });
});

describe("windows, checked from any host", () => {
  const winStation: Station = {
    ...station,
    workspace: "C:\\Users\\noah\\code\\api",
  };

  it("treats drive letter and segment casing as equal", () => {
    expect(
      checkPath(winStation, "c:\\users\\NOAH\\code\\API\\src\\server.ts", win)
        .allowed,
    ).toBe(true);
  });

  it("normalizes backslashes before glob matching", () => {
    expect(
      checkPath(winStation, "C:\\Users\\noah\\code\\api\\src\\deep\\a.ts", win)
        .allowed,
    ).toBe(true);
    expect(
      checkPath(winStation, "C:\\Users\\noah\\code\\api\\infra\\main.tf", win),
    ).toMatchObject({ allowed: false, rule: "infra/**" });
  });

  it("folds filename case, because Windows filenames are not case-sensitive", () => {
    // `path.win32.relative` compares case-insensitively but returns the
    // target's own spelling, so `SECRET.ENV` reaches the matcher verbatim.
    // On Windows that is the same file as `secret.env`; a case-sensitive
    // match walks a renamed `.env` straight past the deny rule.
    const leash: Leash = {
      workspace: "C:\\ws",
      paths: ["**"],
      deny: ["**/*.env"],
    };
    expect(checkPath(leash, "C:\\ws\\SECRET.ENV", win)).toMatchObject({
      allowed: false,
      rule: "**/*.env",
    });
    expect(
      checkPath(leash, "C:\\ws\\INFRA\\main.tf", {
        ...win,
      }).allowed,
    ).toBe(true);
  });

  it("denies a path on a different drive", () => {
    // `path.win32.relative("C:\\a", "D:\\b")` returns `D:\b` — no leading `..`
    // at all, so a `..`-only containment check lets a whole other volume past.
    const decision = checkPath(winStation, "D:\\src\\server.ts", win);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/escapes the workspace/);
  });

  it("expands `~` on Windows, which the OS will not do", () => {
    const tilde: Station = { ...station, workspace: "~\\code\\api" };
    expect(
      checkPath(tilde, "C:\\Users\\noah\\code\\api\\src\\a.ts", win).allowed,
    ).toBe(true);
  });
});

/**
 * Creating a symlink on Windows needs Developer Mode or elevation and throws
 * `EPERM` otherwise. Probing once and skipping is the difference between CI
 * reporting "skipped for lack of privilege" and reporting "the leash is
 * broken" — on the one file where that distinction matters most.
 */
async function canSymlink(): Promise<boolean> {
  const dir = await mkdtemp(path.join(tmpdir(), "cuesheet-link-"));
  try {
    await symlink(dir, path.join(dir, "probe"));
    return true;
  } catch {
    return false;
  }
}

const symlinksSupported = await canSymlink();

describe("resolveAndCheck without symlinks", () => {
  it("agrees with checkPath on an ordinary path", async () => {
    // Runs everywhere, including a Windows box that cannot make symlinks, so
    // the async wrapper is never left completely untested.
    const ws = await realpath(
      await mkdtemp(path.join(tmpdir(), "cuesheet-ws-")),
    );
    const leash: Leash = { workspace: ws, paths: ["src/**"] };
    expect(
      (await resolveAndCheck(leash, path.join(ws, "src", "a.ts"))).allowed,
    ).toBe(true);
    expect(
      (await resolveAndCheck(leash, path.join(ws, "docs", "a.md"))).allowed,
    ).toBe(false);
  });
});

describe.skipIf(!symlinksSupported)("resolveAndCheck (symlinks)", () => {
  async function workspaceWithEscape() {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "cuesheet-ws-")),
    );
    const ws = path.join(root, "api");
    const outside = path.join(root, "outside");
    await mkdir(path.join(ws, "src"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "secret.ts"), "//");
    return { ws, outside };
  }

  const leashFor = (ws: string): Leash => ({
    workspace: ws,
    paths: ["src/**"],
    deny: ["**/*.env"],
  });

  it("denies a symlinked file pointing outside the workspace", async () => {
    const { ws, outside } = await workspaceWithEscape();
    const link = path.join(ws, "src", "escape.ts");
    await symlink(path.join(outside, "secret.ts"), link);

    // Lexically this is `src/escape.ts` and looks perfectly fine.
    expect(checkPath(leashFor(ws), link).allowed).toBe(true);

    const decision = await resolveAndCheck(leashFor(ws), link);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/escapes the workspace/);
  });

  it("denies a file inside a symlinked directory pointing outside", async () => {
    const { ws, outside } = await workspaceWithEscape();
    await symlink(outside, path.join(ws, "src", "vendor"));

    const decision = await resolveAndCheck(
      leashFor(ws),
      path.join(ws, "src", "vendor", "secret.ts"),
    );
    expect(decision.allowed).toBe(false);
  });

  it("still allows a file that does not exist yet", async () => {
    // The common case for a write. Resolving only whole paths would give up
    // here and fall back to lexical checking of a parent that may be a link.
    const { ws } = await workspaceWithEscape();
    const decision = await resolveAndCheck(
      leashFor(ws),
      path.join(ws, "src", "brand", "new.ts"),
    );
    expect(decision.allowed).toBe(true);
  });

  it("allows an ordinary file through a symlinked workspace root", async () => {
    // `/var` is a symlink to `/private/var` on macOS: if the workspace itself
    // is not realpath'd, every path under it reads as an escape.
    const { ws } = await workspaceWithEscape();
    await writeFile(path.join(ws, "src", "a.ts"), "//");
    expect(
      (await resolveAndCheck(leashFor(ws), path.join(ws, "src", "a.ts")))
        .allowed,
    ).toBe(true);
  });

  it("keeps deny rules working after resolution", async () => {
    const { ws } = await workspaceWithEscape();
    const decision = await resolveAndCheck(
      leashFor(ws),
      path.join(ws, "src", ".env"),
    );
    expect(decision).toMatchObject({ allowed: false, rule: "**/*.env" });
  });
});
