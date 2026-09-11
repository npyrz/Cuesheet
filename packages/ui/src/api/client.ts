/**
 * Typed calls against the daemon's HTTP surface.
 *
 * Thin on purpose: the daemon's routes are the contract, and a client that
 * reshapes their responses is a second place the contract lives. The types
 * here are imported from `@cuesheet/core` rather than restated, so a change to
 * a wire shape is a compile error in the Desk rather than a runtime surprise.
 */
import type {
  HarnessProbe,
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
}

export interface ConfigWarning {
  table?: string;
  message: string;
}

export interface StationsResponse {
  stations: StationView[];
  harnesses: HarnessProbe[];
  warnings: ConfigWarning[];
  sourcePath: string | null;
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

export async function fetchStations(): Promise<StationsResponse> {
  return request("/stations");
}

export async function fetchRuns(limit?: number): Promise<Run[]> {
  const query = limit === undefined ? "" : `?limit=${limit}`;
  const { runs } = await request<{ runs: Run[] }>(`/runs${query}`);
  return runs;
}

export async function fetchRun(runId: RunId): Promise<RunDetail> {
  return request(`/runs/${encodeURIComponent(runId)}`);
}

/**
 * The patch, fetched only when someone opens it.
 *
 * Separate from {@link fetchRun} because a run against a workspace with a
 * large untracked tree writes a `diff.patch` measured in megabytes, and most
 * viewings of a run row never expand it. Returns `null` when the run has none.
 */
export async function fetchDiff(runId: RunId): Promise<string | null> {
  const response = await fetch(
    apiUrl(`/runs/${encodeURIComponent(runId)}/diff`),
  );
  if (response.status === 404) return null;
  if (!response.ok)
    throw new ApiError(response.status, await errorText(response));
  return response.text();
}

export async function startRun(
  prompt: string,
  cuesheet?: string,
): Promise<RunId> {
  const { runId } = await request<{ runId: RunId }>("/runs", {
    method: "POST",
    body: JSON.stringify({
      prompt,
      ...(cuesheet !== undefined && { cuesheet }),
    }),
  });
  return runId;
}

export async function stopRun(runId: RunId): Promise<void> {
  await request(`/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" });
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
  draft: NewStation,
): Promise<AddStationResponse> {
  return request("/stations", {
    method: "POST",
    body: JSON.stringify(draft),
  });
}
