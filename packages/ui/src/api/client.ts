/**
 * Typed calls against the daemon's HTTP surface.
 *
 * Thin on purpose: the daemon's routes are the contract, and a client that
 * reshapes their responses is a second place the contract lives. The types
 * here are imported from `@cuesheet/core` rather than restated, so a change to
 * a wire shape is a compile error in the Desk rather than a runtime surprise.
 */
import type {
  Confinement,
  HarnessProbe,
  HarnessUsage,
  Ledger,
  Limits,
  ListedProject,
  Project,
  Role,
  Run,
  RunEvent,
  RunId,
  Station,
} from "@cuesheet/core";
import { apiUrl } from "./base.js";

export interface StationView {
  station: Station;
  probe: HarnessProbe;
  /**
   * What this Station is actually allowed to do — Step 42.
   *
   * Computed by the daemon because half of it is a harness fact: only the
   * harness knows what sandbox flag its subprocess is launched with, and the
   * Desk cannot import `@cuesheet/harness` without inverting the dependency
   * arrow the package layout exists to keep pointing one way.
   */
  enforcement: StationEnforcement;
}

/** Mirrors `StationEnforcement` in `daemon/stations.ts`. */
export interface StationEnforcement {
  /** False only when something refuses writes outright, not merely bounds them. */
  writes: boolean;
  refusedBy: ("daemon" | "harness")[];
  /** Absent when the harness does not declare one — not the same as "none". */
  confinement?: Confinement;
  /** Absent when nothing knows this harness's roles. */
  canPlaySeat?: boolean;
}

export interface ConfigWarning {
  table?: string;
  message: string;
}

export interface StationsResponse {
  stations: StationView[];
  harnesses: HarnessProbe[];
  warnings: ConfigWarning[];
  cuesheets: CuesheetView[];
  /** `[limits]` thresholds — what the strip colours a window against. */
  limits: Limits;
  sourcePath: string | null;
}

/** A named cuesheet, and whether running it puts the work through a Gate. */
export interface CuesheetView {
  id: string;
  stationIds: string[];
  gates: string[];
}

/** `GET /runs/:id` — note that the patch is *not* here; see `fetchDiff`. */
export interface RunDetail {
  run: Run;
  events: RunEvent[];
  hasDiff: boolean;
}

export interface NewStation {
  id: string;
  harness: string;
  role: Role;
  model?: string;
  workspace: string;
  paths?: string[];
  deny?: string[];
}

export interface AddStationResponse {
  station: Station;
  sourcePath: string;
  created: boolean;
  stations: StationsResponse;
}

/**
 * An error carrying the daemon's own message.
 *
 * The routes answer `{ error }` with a status that means something — 409 for a
 * duplicate Station, 400 for a workspace that does not exist — and the Add a
 * Station panel shows that text verbatim. Swallowing it and showing "request
 * failed" is how a user ends up re-typing a path that was never the problem.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), {
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (!response.ok)
    throw new ApiError(response.status, await errorText(response));
  return (await response.json()) as T;
}

async function errorText(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body !== null && typeof body === "object" && "error" in body) {
      const message = (body as { error?: unknown }).error;
      if (typeof message === "string") return message;
    }
  } catch {
    // A non-JSON error body is still an error; fall through to the status.
  }
  return `${response.status} ${response.statusText}`;
}

export async function fetchHealth(): Promise<{ ok: boolean; version: string }> {
  return request("/health");
}

/**
 * Every project the daemon knows about, most recently opened first.
 *
 * Answers on a fresh install with an empty list rather than an error, which is
 * what lets the Desk render a first-run state instead of a failure.
 */
export async function fetchProjects(): Promise<ListedProject[]> {
  const { projects } = await request<{ projects: ListedProject[] }>(
    "/projects",
  );
  return projects;
}

export async function openProject(
  root: string,
  name?: string,
): Promise<Project> {
  const { project } = await request<{ project: Project }>("/projects", {
    method: "POST",
    body: JSON.stringify({ root, ...(name !== undefined && { name }) }),
  });
  return project;
}

/**
 * Forget a project. **Never touches the folder itself.**
 *
 * Here because the launch surface needs it: a recent whose folder is gone
 * cannot be opened, and a list entry that can neither be opened nor removed is
 * a dead end a stranger hits in their first minute. `DELETE /projects/:id`
 * unregisters the entry and leaves the directory, wherever it now is, alone.
 */
export async function forgetProject(projectId: string): Promise<void> {
  await request(scope(projectId), { method: "DELETE" });
}

/**
 * Everything below is project-scoped.
 *
 * The id is a parameter rather than module state on purpose: which project a
 * client is looking at is the client's business, and the daemon has no notion
 * of an active one. That is what makes switching projects in Step 34 something
 * the UI can do without disturbing a run in the project it switched away from.
 */
function scope(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}`;
}

export async function fetchStations(
  projectId: string,
): Promise<StationsResponse> {
  return request(`${scope(projectId)}/stations`);
}

export interface UsageResponse {
  harnesses: HarnessUsage[];
}

/**
 * Plan usage — **not scoped to a project**, and the one call in this file that
 * is not. A five-hour window belongs to a plan; it is the same window
 * whichever repository the Desk is looking at. The strip renders it inside a
 * project, which is why this is worth a line rather than looking like a typo.
 */
export async function fetchUsage(): Promise<UsageResponse> {
  return request("/usage");
}

/**
 * The ledger — **scoped to a project**, unlike `fetchUsage` directly above.
 *
 * The pair is worth reading together: a plan window belongs to a vendor and is
 * the same wherever you are standing, while *spend* belongs to the work that
 * caused it, and the run store it is computed from is already per project.
 *
 * Fetched on demand rather than polled. It reads every run record in the
 * project, which is cheap today and is exactly the call Step 52's SQLite store
 * exists to keep cheap.
 */
export async function fetchLedger(projectId: string): Promise<Ledger> {
  return request(`${scope(projectId)}/ledger`);
}

export async function fetchRuns(
  projectId: string,
  limit?: number,
): Promise<Run[]> {
  const query = limit === undefined ? "" : `?limit=${limit}`;
  const { runs } = await request<{ runs: Run[] }>(
    `${scope(projectId)}/runs${query}`,
  );
  return runs;
}

export async function fetchRun(
  projectId: string,
  runId: RunId,
): Promise<RunDetail> {
  return request(`${scope(projectId)}/runs/${encodeURIComponent(runId)}`);
}

/**
 * The patch, fetched only when someone opens it.
 *
 * Separate from {@link fetchRun} because a run against a workspace with a
 * large untracked tree writes a `diff.patch` measured in megabytes, and most
 * viewings of a run row never expand it. Returns `null` when the run has none.
 */
export async function fetchDiff(
  projectId: string,
  runId: RunId,
): Promise<string | null> {
  const response = await fetch(
    apiUrl(`${scope(projectId)}/runs/${encodeURIComponent(runId)}/diff`),
  );
  if (response.status === 404) return null;
  if (!response.ok)
    throw new ApiError(response.status, await errorText(response));
  return response.text();
}

export async function startRun(
  projectId: string,
  prompt: string,
  cuesheet?: string,
): Promise<RunId> {
  const { runId } = await request<{ runId: RunId }>(
    `${scope(projectId)}/runs`,
    {
      method: "POST",
      body: JSON.stringify({
        prompt,
        ...(cuesheet !== undefined && { cuesheet }),
      }),
    },
  );
  return runId;
}

export async function stopRun(projectId: string, runId: RunId): Promise<void> {
  await request(`${scope(projectId)}/runs/${encodeURIComponent(runId)}/stop`, {
    method: "POST",
  });
}

export async function answerStandby(
  standbyId: string,
  answer: "go" | "no",
): Promise<void> {
  await request(`/standbys/${encodeURIComponent(standbyId)}`, {
    method: "POST",
    body: JSON.stringify({ answer }),
  });
}

export async function addStation(
  projectId: string,
  draft: NewStation,
): Promise<AddStationResponse> {
  return request(`${scope(projectId)}/stations`, {
    method: "POST",
    body: JSON.stringify(draft),
  });
}
