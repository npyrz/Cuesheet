/**
 * The leashed workspace facade.
 *
 * This is where the README's central safety claim is actually implemented:
 * "A Station denied `infra/**` cannot write there even if the model decides it
 * should." Not a prompt, not a convention — a check on the path, in the
 * runtime, before the write.
 *
 * The decision logic itself is `checkPath`/`resolveAndCheck` in
 * `@cuesheet/core`, which is a pure function precisely so it can be hammered
 * by tests from either OS. Nothing is re-decided here; this file resolves
 * paths, calls it, and turns a `false` into a refusal the operator can see.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  expandHome,
  hostEnv,
  pathFor,
  resolveAndCheck,
  toPosix,
  type HostEnv,
  type Station,
} from "@cuesheet/core";
import { diffWorkspace } from "./git.js";
import {
  LeashDeniedError,
  type DiffResult,
  type HarnessEvent,
  type LeashCheck,
  type Workspace,
} from "./types.js";

export interface WorkspaceOptions {
  station: Station;
  env?: HostEnv;
  /**
   * Where refusals go. A denial the operator never sees is indistinguishable
   * from a harness that quietly decided not to bother, so this is required in
   * practice even though the type allows omitting it.
   */
  emit?: (event: HarnessEvent) => void;
  signal?: AbortSignal;
}

export class NoWorkspaceError extends Error {
  constructor(stationId: string) {
    super(
      `Station "${stationId}" has no workspace. Set \`workspace\` on its ` +
        `[[station]] block; without one the leash denies every path and the ` +
        `run would fail with no visible cause.`,
    );
    this.name = "NoWorkspaceError";
  }
}

/**
 * Build the facade for one Station.
 *
 * Throws when the Station has no workspace, and does it *here* rather than
 * letting the leash deny path after path. Both end the run, but only one says
 * why — an empty `workspace` otherwise surfaces as "denied" on every file the
 * agent touches, which reads like a permissions bug and is a config gap.
 */
export function createWorkspace(options: WorkspaceOptions): Workspace {
  const { station } = options;
  const env = options.env ?? hostEnv();
  const p = pathFor(env);

  if (!station.workspace) throw new NoWorkspaceError(station.id);

  // `~` is expanded here, once. The OS does not expand it on either platform,
  // and `spawn`'s `cwd` least of all — a Station on `~/code/api` otherwise
  // becomes a literal directory named `~`.
  const root = p.resolve(expandHome(station.workspace, env));

  function absolute(target: string): string {
    return p.resolve(root, expandHome(target, env));
  }

  async function decide(target: string): Promise<LeashCheck> {
    const decision = await resolveAndCheck(station, absolute(target), env);
    return {
      allowed: decision.allowed,
      ...(decision.reason !== undefined && { reason: decision.reason }),
      ...(decision.rule !== undefined && { rule: decision.rule }),
    };
  }

  async function guard(target: string): Promise<string> {
    const decision = await decide(target);
    if (!decision.allowed) {
      const reason = decision.reason ?? "Outside this Station's leash.";
      options.emit?.({ t: "denial", reason, path: target });
      throw new LeashDeniedError(target, reason, decision.rule);
    }
    return absolute(target);
  }

  return {
    path: root,

    check: decide,

    async read(target) {
      const file = await guard(target);
      const contents = await readFile(file, "utf8");
      options.emit?.({ t: "file", path: relative(file), op: "read" });
      return contents;
    },

    async write(target, contents) {
      const file = await guard(target);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, contents, "utf8");
      options.emit?.({ t: "file", path: relative(file), op: "write" });
    },

    async exists(target) {
      // Deliberately checked before the stat: whether a denied path exists is
      // itself information the leash is meant to withhold.
      const decision = await decide(target);
      if (!decision.allowed) return false;
      try {
        await readFile(absolute(target));
        return true;
      } catch (error) {
        return !isNotFound(error);
      }
    },

    async list(target = ".") {
      const dir = await guard(target);
      const entries = await readdir(dir, { withFileTypes: true });
      return entries
        .map((entry) => relative(p.join(dir, entry.name)))
        .sort((a, b) => a.localeCompare(b));
    },

    diff(): Promise<DiffResult> {
      return diffWorkspace({
        cwd: root,
        ...(options.signal !== undefined && { signal: options.signal }),
      });
    },
  };

  /** Workspace-relative and posix, because that is what an event should carry. */
  function relative(file: string): string {
    const rel = p.relative(root, file);
    return rel === "" ? "." : toPosix(rel, env);
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
