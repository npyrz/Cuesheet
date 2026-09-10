import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import type { Station } from "@cuesheet/core";
import { createWorkspace, NoWorkspaceError } from "./workspace.js";
import { LeashDeniedError, type HarnessEvent } from "./types.js";

let root: string;

beforeEach(async () => {
  // `realpath` because /var is a symlink to /private/var on macOS, and the
  // leash resolves symlinks before checking — an unresolved root would make
  // every path look like an escape.
  root = await realpath(await mkdtemp(path.join(tmpdir(), "cuesheet-ws-")));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "infra"), { recursive: true });
});

function station(overrides: Partial<Station> = {}): Station {
  return {
    id: "opus",
    harness: "mock",
    role: "engineer",
    workspace: root,
    paths: ["src/**"],
    deny: ["**/*.env", "infra/**"],
    ...overrides,
  };
}

function build(overrides: Partial<Station> = {}) {
  const events: HarnessEvent[] = [];
  const workspace = createWorkspace({
    station: station(overrides),
    emit: (event) => events.push(event),
  });
  return { workspace, events };
}

describe("createWorkspace", () => {
  it("writes inside an allowed path and reports the file", async () => {
    const { workspace, events } = build();
    await workspace.write("src/app.ts", "export {};\n");
    expect(await readFile(path.join(root, "src/app.ts"), "utf8")).toBe(
      "export {};\n",
    );
    expect(events).toContainEqual({
      t: "file",
      path: "src/app.ts",
      op: "write",
    });
  });

  it("refuses a write outside the allowed paths", async () => {
    const { workspace } = build();
    await expect(workspace.write("docs/readme.md", "x")).rejects.toBeInstanceOf(
      LeashDeniedError,
    );
  });

  it("refuses a write outside the workspace entirely", async () => {
    // The `../` escape. `path.relative`, not a string prefix, is what catches
    // this; a prefix check passes for `/tmp/foo-evil` against `/tmp/foo`.
    const { workspace } = build({ paths: ["**"] });
    await expect(workspace.write("../escaped.txt", "x")).rejects.toBeInstanceOf(
      LeashDeniedError,
    );
  });

  it("lets a deny glob beat an allow glob", async () => {
    // The README's exact case: `**/*.env` denied while `src/**` is allowed.
    // Note the file is a bare `.env`, not `config.env` — without picomatch's
    // `dot: true` the rule misses the one file it exists to protect.
    const { workspace } = build();
    await expect(
      workspace.write("src/.env", "SECRET=1"),
    ).rejects.toBeInstanceOf(LeashDeniedError);
  });

  it("emits a denial the operator can see", async () => {
    // A refusal nobody is told about is indistinguishable from a harness that
    // quietly decided not to bother.
    const { workspace, events } = build();
    await workspace.write("infra/main.tf", "x").catch(() => undefined);
    const denial = events.find((event) => event.t === "denial");
    expect(denial).toBeDefined();
    expect(denial).toMatchObject({ t: "denial", path: "infra/main.tf" });
  });

  it("does not create the file it refused", async () => {
    const { workspace } = build();
    await workspace.write("infra/main.tf", "x").catch(() => undefined);
    await expect(
      readFile(path.join(root, "infra/main.tf"), "utf8"),
    ).rejects.toThrow();
  });

  it("reads an allowed file and refuses a denied one", async () => {
    await writeFile(path.join(root, "src/ok.ts"), "ok", "utf8");
    await writeFile(path.join(root, "infra/secret.tf"), "nope", "utf8");
    const { workspace } = build();
    expect(await workspace.read("src/ok.ts")).toBe("ok");
    await expect(workspace.read("infra/secret.tf")).rejects.toBeInstanceOf(
      LeashDeniedError,
    );
  });

  it("reports a denied path as absent rather than leaking its existence", async () => {
    await writeFile(path.join(root, "infra/secret.tf"), "nope", "utf8");
    const { workspace } = build();
    expect(await workspace.exists("infra/secret.tf")).toBe(false);
    expect(await workspace.exists("src")).toBe(true);
  });

  it("creates missing parent directories on write", async () => {
    const { workspace } = build({ paths: ["src/**"] });
    await workspace.write("src/deep/nested/file.ts", "x");
    expect(
      await readFile(path.join(root, "src/deep/nested/file.ts"), "utf8"),
    ).toBe("x");
  });

  it("expands ~ in the Station's workspace", () => {
    // Windows does not expand `~` and neither does `spawn`'s cwd; a Station on
    // `~/code/api` would otherwise become a literal directory named `~`.
    const workspace = createWorkspace({
      station: station({ workspace: "~/code/api" }),
    });
    expect(workspace.path).not.toContain("~");
    expect(path.isAbsolute(workspace.path)).toBe(true);
  });

  it("names the missing config rather than denying every path", async () => {
    // Without a workspace the leash denies everything, which reads like a
    // permissions bug and is a config gap. Fail once, with the reason.
    expect(() =>
      createWorkspace({ station: station({ workspace: undefined }) }),
    ).toThrow(NoWorkspaceError);
    expect(() =>
      createWorkspace({ station: station({ workspace: undefined }) }),
    ).toThrow(/no workspace/i);
  });

  it("reports leash decisions without throwing", async () => {
    const { workspace } = build();
    expect((await workspace.check("src/app.ts")).allowed).toBe(true);
    const denied = await workspace.check("infra/main.tf");
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBeTruthy();
  });

  it("lists an allowed directory as workspace-relative posix paths", async () => {
    await writeFile(path.join(root, "src/b.ts"), "", "utf8");
    await writeFile(path.join(root, "src/a.ts"), "", "utf8");
    const { workspace } = build();
    expect(await workspace.list("src")).toEqual(["src/a.ts", "src/b.ts"]);
  });
});
