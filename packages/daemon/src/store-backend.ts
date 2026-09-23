/**
 * Which run store a project gets, and who decides.
 *
 * Step 52's done-when has two halves: SQLite is fast at ten thousand runs,
 * *and* "the file store still passes the same suite so an operator can
 * choose". This is the choosing. It is one function rather than a config
 * table because the backend is a property of the installation, not of a
 * project's workflow — `cuesheet.toml` describes Stations, Gates and limits,
 * and a per-project storage engine would mean one daemon holding two
 * different answers to "where are my runs" with nothing in the UI to say so.
 *
 * The default is SQLite, and the fallback is silent only in the one case
 * where silence is right: a runtime with no `node:sqlite` at all. That is an
 * environment fact the operator did not choose and cannot fix from here, and
 * the file store is a correct store rather than a degraded one — it passes
 * the same contract. An operator who *asked* for `sqlite` and cannot have it
 * gets an error instead, because that request was a decision and answering a
 * decision with a different one quietly is how trust goes.
 */
import { hostEnv, runsDir, type HostEnv } from "@cuesheet/core";
import type { RunIdFactory } from "./ids.js";
import { createFileRunStore, type RunStore } from "./store.js";
import { openSqliteRunStore, sqliteAvailable } from "./store-sqlite.js";

export type RunStoreBackend = "sqlite" | "files";

export const DEFAULT_RUN_STORE_BACKEND: RunStoreBackend = "sqlite";

/** The env var an operator sets to override the default. */
export const RUN_STORE_ENV_VAR = "CUESHEET_RUN_STORE";

export interface OpenRunStoreOptions {
  env?: HostEnv;
  /** The runs root. Defaults to `~/.cuesheet/runs` under `env`. */
  root?: string;
  /** Explicit wins over the environment, which wins over the default. */
  backend?: RunStoreBackend;
  newId?: RunIdFactory;
  now?: () => Date;
}

/**
 * Read `CUESHEET_RUN_STORE`. `undefined` for absent, empty or unrecognised.
 *
 * Unrecognised is deliberately not an error: this is read at boot, and a
 * typo'd env var that refuses to start the daemon is a worse failure than one
 * that starts on the default. Takes the variables rather than reading
 * `process.env`, for the same reason every path helper takes a `HostEnv`.
 */
export function resolveRunStoreBackend(
  variables: Record<string, string | undefined> = process.env,
): RunStoreBackend | undefined {
  const value = variables[RUN_STORE_ENV_VAR]?.trim().toLowerCase();
  if (value === "sqlite" || value === "files") return value;
  return undefined;
}

export async function openRunStore(
  options: OpenRunStoreOptions = {},
): Promise<RunStore> {
  const env = options.env ?? hostEnv();
  const root = options.root ?? runsDir(env);
  const asked = options.backend ?? resolveRunStoreBackend();
  const backend = asked ?? DEFAULT_RUN_STORE_BACKEND;

  const fileStore = (): RunStore =>
    createFileRunStore({
      root,
      ...(options.newId !== undefined && { newId: options.newId }),
      ...(options.now !== undefined && { now: options.now }),
    });

  if (backend === "files") return fileStore();

  if (asked === undefined && !(await sqliteAvailable())) return fileStore();

  return openSqliteRunStore({
    env,
    root,
    ...(options.newId !== undefined && { newId: options.newId }),
    ...(options.now !== undefined && { now: options.now }),
  });
}
