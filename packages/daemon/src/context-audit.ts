import { readFile } from "node:fs/promises";
import nodePath from "node:path";
import {
  BYTES_PER_TOKEN,
  expandHome,
  isStationCue,
  type Config,
  type ContextLoadAudit,
  type ContextLoadAuditFile,
  type ContextLoadAuditStation,
  type HostEnv,
} from "@cuesheet/core";
import type { ContextFile } from "@cuesheet/harness";
import { PROJECTION_BEGIN, PROJECTION_END } from "./projections.js";

export type HarnessContextFiles = (
  harness: string,
) => readonly ContextFile[] | undefined;

/**
 * Read current bytes without regenerating projections or starting a harness.
 * Keep declarations attached to their harness: flattening them, as the
 * projector does, would charge a Codex Station for CLAUDE.md too.
 */
export async function auditContext(options: {
  config: Config;
  env: HostEnv;
  filesOf: HarnessContextFiles;
  runs: number;
}): Promise<ContextLoadAudit> {
  const files = new Map<string, ContextLoadAuditFile>();
  const stations: ContextLoadAuditStation[] = [];
  for (const station of options.config.station) {
    const declared = options.filesOf(station.harness);
    const row: ContextLoadAuditStation = {
      id: station.id,
      harness: station.harness,
      filePaths: [],
      estimatedTokens: 0,
      complete: declared !== undefined && station.workspace !== undefined,
    };
    if (declared === undefined)
      row.reason = "Harness context declarations are unknown.";
    else if (station.workspace === undefined)
      row.reason = "Station has no workspace.";
    if (declared !== undefined && station.workspace !== undefined) {
      for (const file of declared) {
        // Match the executor's current workspace resolution, including its
        // relative-path semantics; pretending these resolve at the project
        // root would audit a different file from the one the agent reads.
        const scopeRoot =
          file.scope === "user"
            ? options.env.homedir
            : nodePath.resolve(expandHome(station.workspace, options.env));
        const target = nodePath.resolve(scopeRoot, file.path);
        const relative = nodePath.relative(scopeRoot, target);
        if (
          nodePath.isAbsolute(file.path) ||
          relative === ".." ||
          relative.startsWith(`..${nodePath.sep}`)
        ) {
          row.complete = false;
          row.reason = "Harness context path escapes its scope root.";
          continue;
        }
        if (row.filePaths.includes(target)) continue;
        row.filePaths.push(target);
        let measured = files.get(target);
        if (measured === undefined) {
          measured = await measure(target, file.scope);
          files.set(target, measured);
        }
        measured.stationIds.push(station.id);
        row.estimatedTokens += measured.estimatedTokens ?? 0;
        if (measured.state === "unreadable") row.complete = false;
      }
    }
    stations.push(row);
  }
  const byId = new Map(stations.map((station) => [station.id, station]));
  const first = options.config.station[0];
  const plans = [
    { cuesheet: null, stationIds: first === undefined ? [] : [first.id] },
    ...Object.entries(options.config.cuesheet).map(([cuesheet, sheet]) => ({
      cuesheet,
      stationIds: sheet.cues.filter(isStationCue).map((cue) => cue.station),
    })),
  ].map((plan) => {
    const rows = plan.stationIds.map((id) => byId.get(id));
    const estimatedTokensPerRun = rows.reduce(
      (total, row) => total + (row?.estimatedTokens ?? 0),
      0,
    );
    return {
      ...plan,
      estimatedTokensPerRun,
      estimatedTokens: estimatedTokensPerRun * options.runs,
      complete: rows.every((row) => row?.complete === true),
    };
  });
  return {
    runs: options.runs,
    files: [...files.values()].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ),
    stations,
    plans,
    estimatedTokensAcrossStations: stations.reduce(
      (total, station) => total + station.estimatedTokens,
      0,
    ),
    complete: stations.every((station) => station.complete),
    notes: [
      "Estimated at four UTF-8 bytes per token. These are context inputs, not dollars or measured usage; caching and subscription pricing change the bill.",
      "Current files declared by each harness only. Ancestor/nested instructions, vendor system prompts, inline Commons, the task brief, diffs and tool results are excluded.",
      "Cuesheet estimates count every Station cue, including repeats. Skipped reviews, early stops and cap fallback routing can change actual loads. Runs multiplies the current estimate; it does not reconstruct historical file sizes.",
    ],
  };
}

async function measure(
  path: string,
  scope: ContextFile["scope"],
): Promise<ContextLoadAuditFile> {
  const row: ContextLoadAuditFile = {
    path,
    scope,
    stationIds: [],
    state: "present",
    bytes: null,
    estimatedTokens: null,
    projectionEstimatedTokens: null,
  };
  try {
    const bytes = await readFile(path);
    row.bytes = bytes.length;
    row.estimatedTokens = Math.ceil(bytes.length / BYTES_PER_TOKEN);
    const begin = bytes.indexOf(PROJECTION_BEGIN);
    const end = bytes.indexOf(PROJECTION_END, begin);
    row.projectionEstimatedTokens =
      begin !== -1 && end > begin
        ? Math.ceil(
            (end + Buffer.byteLength(PROJECTION_END) - begin) / BYTES_PER_TOKEN,
          )
        : 0;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      row.state = "missing";
      row.bytes = 0;
      row.estimatedTokens = 0;
      row.projectionEstimatedTokens = 0;
    } else {
      row.state = "unreadable";
      row.error = `Could not read context file${code === undefined ? "." : ` (${code}).`}`;
    }
  }
  return row;
}
