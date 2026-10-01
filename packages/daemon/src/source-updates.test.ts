import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import nodePath from "node:path";
import { tmpdir } from "node:os";
import { run } from "@cuesheet/harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applySourceUpdate,
  createSourceUpdates,
  inspectSourceUpdate,
  type SourceUpdateOptions,
} from "./source-updates.js";
import Fastify from "fastify";
import { registerUpdateRoutes } from "./updates.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
let scratch: string;
let root: string;
let upstream: string;
let before: string;
let after: string;
let options: SourceUpdateOptions;
const git = async (cwd: string, ...args: string[]) => {
  const result = await run("git", args, { cwd, timeoutMs: 15_000 });
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};
beforeEach(async () => {
  scratch = await mkdtemp(nodePath.join(tmpdir(), "cs-source-update-"));
  upstream = nodePath.join(scratch, "upstream");
  root = nodePath.join(scratch, "checkout with spaces");
  await mkdir(upstream);
  await git(upstream, "init", "-b", "main");
  await git(upstream, "config", "user.name", "Fixture");
  await git(upstream, "config", "user.email", "fixture@invalid");
  await git(upstream, "config", "core.autocrlf", "false");
  await writeFile(
    nodePath.join(upstream, ".gitignore"),
    "node_modules/\ndist/\n.env\n",
  );
  await writeFile(
    nodePath.join(upstream, "package.json"),
    JSON.stringify({
      name: "cuesheet",
      version: "1.0.0",
      private: true,
      scripts: {
        build:
          "node -e \"require('fs').mkdirSync('dist',{recursive:true}); require('fs').writeFileSync('dist/version',require('./package.json').version)\"",
      },
    }),
  );
  await writeFile(
    nodePath.join(upstream, "package-lock.json"),
    JSON.stringify({
      name: "cuesheet",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: { "": { name: "cuesheet", version: "1.0.0" } },
    }),
  );
  await git(upstream, "add", ".");
  await git(upstream, "commit", "-m", "old release");
  before = await git(upstream, "rev-parse", "HEAD");
  await git(scratch, "clone", upstream, root);
  const pkg = JSON.parse(
    await readFile(nodePath.join(upstream, "package.json"), "utf8"),
  );
  pkg.version = "1.1.0";
  await writeFile(nodePath.join(upstream, "package.json"), JSON.stringify(pkg));
  await writeFile(nodePath.join(upstream, "new-file"), "new release\n");
  await git(upstream, "add", ".");
  await git(upstream, "commit", "-m", "new release");
  after = await git(upstream, "rev-parse", "HEAD");
  await git(upstream, "tag", "v1.1.0");
  options = {
    root,
    running: async () => false,
    fetcher: vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            tag_name: "v1.1.0",
            draft: false,
            prerelease: false,
          }),
        ),
    ) as typeof fetch,
    // Real Git and npm with only the remote URL redirected to the local fixture.
    runner: (bin, args, opts) =>
      run(
        bin,
        args.map((arg) =>
          arg === "https://github.com/npyrz/Cuesheet.git" ? upstream : arg,
        ),
        opts,
      ),
  };
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true, maxRetries: 10 });
});

describe("source release updates", () => {
  it("checks without changing files and fast-forwards/rebuilds a stopped checkout without touching user data", async () => {
    const user = nodePath.join(scratch, "user-state");
    await mkdir(user);
    await writeFile(nodePath.join(user, "runs.db"), "history sentinel");
    await writeFile(nodePath.join(root, ".env"), "private configuration");
    const status = await inspectSourceUpdate(options);
    expect(status).toMatchObject({
      phase: "available",
      currentRevision: before,
      targetRevision: after,
      mode: "source",
    });
    expect(await git(root, "rev-parse", "HEAD")).toBe(before);
    const result = await applySourceUpdate(options);
    expect(result.phase).toBe("idle");
    expect(await git(root, "rev-parse", "HEAD")).toBe(after);
    expect(await readFile(nodePath.join(root, "dist/version"), "utf8")).toBe(
      "1.1.0",
    );
    expect(await readFile(nodePath.join(root, ".env"), "utf8")).toBe(
      "private configuration",
    );
    expect(await readFile(nodePath.join(user, "runs.db"), "utf8")).toBe(
      "history sentinel",
    );
    expect(await git(root, "status", "--porcelain")).toBe("");
    expect((await applySourceUpdate(options)).phase).toBe("idle");
  });
  it("refuses a release that would overwrite ignored local configuration", async () => {
    await writeFile(nodePath.join(upstream, ".env"), "release content");
    await git(upstream, "add", "-f", ".env");
    await git(
      upstream,
      "commit",
      "-m",
      "tracked file conflicts with local config",
    );
    await git(upstream, "tag", "-f", "v1.1.0");
    await writeFile(nodePath.join(root, ".env"), "private configuration");
    await expect(applySourceUpdate(options)).rejects.toThrow("git failed");
    expect(await git(root, "rev-parse", "HEAD")).toBe(before);
    expect(await readFile(nodePath.join(root, ".env"), "utf8")).toBe(
      "private configuration",
    );
  });
  it("refuses a running daemon, local edits and untracked files without moving HEAD", async () => {
    await expect(
      applySourceUpdate({ ...options, running: async () => true }),
    ).rejects.toThrow("Stop Cuesheet");
    await writeFile(nodePath.join(root, "package.json"), "local edits");
    await expect(applySourceUpdate(options)).rejects.toThrow("Commit or stash");
    await git(root, "restore", "package.json");
    await writeFile(nodePath.join(root, "notes"), "operator notes");
    await expect(applySourceUpdate(options)).rejects.toThrow("Commit or stash");
    expect(await git(root, "rev-parse", "HEAD")).toBe(before);
    expect(await readFile(nodePath.join(root, "notes"), "utf8")).toBe(
      "operator notes",
    );
  });
  it("restores the old commit and rebuilds after the new build fails, including removing newly tracked files", async () => {
    let failed = false;
    const runner: typeof run = async (bin, args, opts) => {
      if (bin === "npm" && args[0] === "run" && !failed) {
        failed = true;
        return {
          code: 1,
          signal: null,
          killed: false,
          stdout: "",
          stderr: "fixture build failure",
        };
      }
      return options.runner!(bin, args, opts);
    };
    await expect(applySourceUpdate({ ...options, runner })).rejects.toThrow(
      "Restored and rebuilt",
    );
    expect(await git(root, "rev-parse", "HEAD")).toBe(before);
    expect(await git(root, "status", "--porcelain")).toBe("");
    expect(await readFile(nodePath.join(root, "dist/version"), "utf8")).toBe(
      "1.0.0",
    );
    await expect(readFile(nodePath.join(root, "new-file"))).rejects.toThrow();
  });
  it("does not downgrade ahead checkouts or overwrite divergent commits", async () => {
    await applySourceUpdate(options);
    await git(root, "config", "user.name", "Fixture");
    await git(root, "config", "user.email", "fixture@invalid");
    await writeFile(nodePath.join(root, "my-work"), "local commit");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "local commit");
    expect((await inspectSourceUpdate(options)).message).toContain("ahead");
    await git(root, "checkout", before);
    await writeFile(nodePath.join(root, "different-work"), "divergent commit");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "different commit");
    const head = await git(root, "rev-parse", "HEAD");
    expect((await applySourceUpdate(options)).phase).toBe("unavailable");
    expect(await git(root, "rev-parse", "HEAD")).toBe(head);
  });
  it("coalesces HTTP checks, exposes source instructions, and refuses installer control", async () => {
    const service = createSourceUpdates(options);
    const app = Fastify();
    registerUpdateRoutes(app, service);
    try {
      const first = service.check();
      expect(service.check()).toBe(first);
      await first;
      expect(options.fetcher).toHaveBeenCalledTimes(1);
      expect((await app.inject("/updates")).json()).toMatchObject({
        phase: "available",
        command: "npm run update",
      });
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/updates/install",
            payload: { confirm: true },
          })
        ).statusCode,
      ).toBe(409);
    } finally {
      await app.close();
    }
  });
  it("refuses edits or a running daemon that appear during the network check", async () => {
    await expect(
      applySourceUpdate({
        ...options,
        fetcher: async (...args) => {
          await writeFile(nodePath.join(root, "notes"), "new local work");
          return options.fetcher!(...args);
        },
      }),
    ).rejects.toThrow("Local changes appeared");
    await rm(nodePath.join(root, "notes"));
    let probes = 0;
    await expect(
      applySourceUpdate({ ...options, running: async () => ++probes > 1 }),
    ).rejects.toThrow("started during");
    expect(await git(root, "rev-parse", "HEAD")).toBe(before);
  });
  it("preserves operator edits made during a failed build instead of rolling them away", async () => {
    const runner: typeof run = async (bin, args, opts) => {
      if (bin === "npm" && args[0] === "run") {
        await writeFile(nodePath.join(root, "new-file"), "operator edit");
        return {
          code: 1,
          signal: null,
          killed: false,
          stdout: "",
          stderr: "build failure",
        };
      }
      return options.runner!(bin, args, opts);
    };
    await expect(applySourceUpdate({ ...options, runner })).rejects.toThrow(
      "left untouched",
    );
    expect(await readFile(nodePath.join(root, "new-file"), "utf8")).toBe(
      "operator edit",
    );
    expect(await git(root, "rev-parse", "HEAD")).toBe(after);
  });
  it("refuses a concurrent updater lock", async () => {
    await writeFile(
      nodePath.join(root, ".git", "cuesheet-update.lock"),
      "running",
    );
    await expect(applySourceUpdate(options)).rejects.toThrow();
    expect(await git(root, "rev-parse", "HEAD")).toBe(before);
    expect(
      await readFile(
        nodePath.join(root, ".git", "cuesheet-update.lock"),
        "utf8",
      ),
    ).toBe("running");
  });
  it("handles a repository with only prereleases and an empty published set", async () => {
    let published = [{ tag_name: "v1.1.0", draft: false, prerelease: true }];
    const fetcher: typeof fetch = async (input) =>
      String(input).endsWith("/latest")
        ? new Response("not found", { status: 404 })
        : new Response(JSON.stringify(published));
    expect((await inspectSourceUpdate({ ...options, fetcher })).phase).toBe(
      "available",
    );
    published = [];
    expect(
      (await inspectSourceUpdate({ ...options, fetcher })).message,
    ).toContain("No published releases");
    expect(await git(root, "rev-parse", "HEAD")).toBe(before);
  });
  it("surfaces offline/API failures and rejects unpublished or option-like tags", async () => {
    const service = createSourceUpdates({
      ...options,
      fetcher: async () => new Response("limited", { status: 403 }),
    });
    await service.check();
    expect(service.status()).toMatchObject({ phase: "error", mode: "source" });
    for (const release of [
      { tag_name: "--upload-pack=bad", draft: false },
      { tag_name: "v1.1.0", draft: true },
    ]) {
      await expect(
        inspectSourceUpdate({
          ...options,
          tag: "v1.1.0",
          fetcher: async () => new Response(JSON.stringify(release)),
        }),
      ).rejects.toThrow("unpublished");
    }
    expect(await git(root, "rev-parse", "HEAD")).toBe(before);
  });
});
