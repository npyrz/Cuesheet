import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  isTerminalStatus,
  type HostEnv,
  type RunEvent,
  type RunStatus,
} from "@cuesheet/core";
import { isRunId } from "./ids.js";
import { DAEMON_VERSION } from "./version.js";

const MAX_BYTES = 512 * 1024;
const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 12);

type Activity = {
  project: string;
  run: string;
  station?: string;
  status: RunStatus;
};
export interface Diagnostics {
  readonly path: string;
  available(): boolean;
  start(): void;
  close(): void;
  observe(project: string, event: RunEvent): void;
  error(operation: string, error: unknown): void;
  recovered(project: string, runs: string[]): void;
  report(): string;
}

/**
 * Select metadata before writing, rather than redacting arbitrary payloads
 * afterwards. Error messages and model/tool output can contain credentials;
 * neither belongs in a report a stranger is invited to attach publicly.
 * Synchronous checkpoints are deliberate: a fatal exception or SIGKILL must
 * not depend on an async queue getting another turn before its context lands.
 */
export function createDiagnostics(env: HostEnv): Diagnostics {
  const root = join(env.homedir, ".cuesheet", "diagnostics");
  const path = join(root, "events.jsonl");
  const checkpoint = join(root, "session.json");
  const active = new Map<string, Activity>();
  let available = true;
  let started = false;
  const fatal = (error: Error): void => service.error("process-fatal", error);

  function attempt(action: () => void): void {
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      action();
    } catch {
      // A full disk must not turn a diagnostic failure into a run failure.
      available = false;
    }
  }
  function record(operation: string, detail: object = {}): void {
    attempt(() => {
      if (existsSync(path) && statSync(path).size >= MAX_BYTES) {
        if (existsSync(`${path}.1`)) renameSync(`${path}.1`, `${path}.2`);
        renameSync(path, `${path}.1`);
      }
      appendFileSync(
        path,
        `${JSON.stringify({ at: new Date().toISOString(), operation, ...detail })}\n`,
        { mode: 0o600 },
      );
    });
  }
  function save(clean: boolean): void {
    attempt(() => {
      const temporary = `${checkpoint}.tmp`;
      writeFileSync(
        temporary,
        JSON.stringify({ clean, active: [...active.values()] }),
        { mode: 0o600 },
      );
      renameSync(temporary, checkpoint);
    });
  }
  const service: Diagnostics = {
    path,
    available: () => available,
    start() {
      if (started) return;
      started = true;
      attempt(() => {
        if (!existsSync(checkpoint)) return;
        const previous = JSON.parse(readFileSync(checkpoint, "utf8")) as {
          clean?: boolean;
          active?: unknown[];
        };
        if (previous.clean !== true) {
          record("previous-session-unclean");
          for (const item of Array.isArray(previous.active)
            ? previous.active
            : []) {
            if (typeof item !== "object" || item === null) continue;
            const value = item as Activity;
            if (!isRunId(value.run) || !/^[a-f0-9]{12}$/.test(value.project))
              continue;
            record("run-at-process-loss", {
              project: value.project,
              run: value.run,
              ...(typeof value.station === "string" &&
                /^[a-f0-9]{12}$/.test(value.station) && {
                  station: value.station,
                }),
            });
          }
        }
      });
      record("session-start", {
        version: DAEMON_VERSION,
        platform: env.platform,
        arch: process.arch,
        node: process.versions.node,
      });
      save(false);
      process.on("uncaughtExceptionMonitor", fatal);
    },
    close() {
      if (!started) return;
      process.off("uncaughtExceptionMonitor", fatal);
      record("session-stop");
      active.clear();
      save(true);
      started = false;
    },
    observe(project, event) {
      if (!isRunId(event.runId)) return;
      const key = `${project}:${event.runId}`;
      const previous = active.get(key);
      const next: Activity = {
        project: hash(project),
        run: event.runId,
        status: previous?.status ?? "running",
        ...(previous?.station && { station: previous.station }),
      };
      if (event.t === "status") next.status = event.status;
      if (event.t === "done") next.status = event.result.status;
      if ("stationId" in event) next.station = hash(event.stationId);
      if (event.t === "error") record("run-error", next);
      if (JSON.stringify(previous) === JSON.stringify(next)) return;
      record("run-state", next);
      if (isTerminalStatus(next.status)) active.delete(key);
      else active.set(key, next);
      if (started) save(false);
    },
    error(operation, error) {
      // Keep call-site line numbers without serializing messages or personal
      // paths. Frame labels are omitted too: arbitrary throws own their stack.
      const frames =
        error instanceof Error
          ? (error.stack ?? "")
              .split("\n")
              .slice(1, 9)
              .flatMap((line) => {
                const match =
                  /[/\\]([a-zA-Z0-9_.-]+\.[cm]?[jt]s):(\d+):(\d+)\)?$/.exec(
                    line,
                  );
                return match ? [`${match[1]}:${match[2]}:${match[3]}`] : [];
              })
          : [];
      const code =
        error !== null && typeof error === "object" && "code" in error
          ? error.code
          : undefined;
      const knownCode =
        typeof code === "string" &&
        [
          "EACCES",
          "EPERM",
          "ENOSPC",
          "ENOENT",
          "EBUSY",
          "EIO",
          "ECONNREFUSED",
          "ECONNRESET",
          "ETIMEDOUT",
          "EADDRINUSE",
        ].includes(code)
          ? code
          : undefined;
      record(operation, {
        ...(knownCode && { code: knownCode }),
        kind:
          error instanceof TypeError
            ? "TypeError"
            : error instanceof SyntaxError
              ? "SyntaxError"
              : error instanceof RangeError
                ? "RangeError"
                : "Error",
        frames,
      });
    },
    recovered(project, runs) {
      for (const run of runs)
        if (isRunId(run))
          record("run-reconciled-interrupted", { project: hash(project), run });
    },
    report() {
      const logs: string[] = [];
      for (const file of [`${path}.2`, `${path}.1`, path]) {
        if (existsSync(file)) logs.push(readFileSync(file, "utf8"));
      }
      if (!available)
        throw new Error(
          "Local diagnostics could not be persisted. Check available disk space and permissions.",
        );
      return [
        "Cuesheet local diagnostic report",
        `Version: ${DAEMON_VERSION}; OS: ${env.platform}; architecture: ${process.arch}; Node: ${process.versions.node}`,
        "Project and Station identifiers are hashed. Run IDs and times are retained.",
        "Prompts, source, diffs, tool payloads, credentials, error messages and personal paths are omitted.",
        "Review before attaching. Nothing is uploaded by Cuesheet.",
        "Describe what you expected, what happened, and how to reproduce it:",
        "",
        ...logs,
      ].join("\n");
    },
  };
  return service;
}
