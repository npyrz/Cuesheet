/**
 * The CLI is an HTTP client of cuesheetd. It selects a registered project
 * from the working directory, but the daemon owns every operation.
 */
import { readFile, realpath } from "node:fs/promises";
import nodePath from "node:path";
import {
  daemonLockFile,
  hostEnv,
  type HostEnv,
  type ListedProject,
  type Run,
} from "@cuesheet/core";

export interface CliOptions {
  cwd?: string;
  env?: HostEnv;
  variables?: NodeJS.ProcessEnv;
  output?: (line: string) => void;
  error?: (line: string) => void;
  fetcher?: typeof fetch;
}

class CliError extends Error {}

const HELP = `Usage: cuesheet <command> [options]

Commands:
  projects                         List registered projects
  project add [path]               Register a project (default: current directory)
  stations [--project ID]          List Stations and cuesheets
  run [--project ID] [--cuesheet NAME] <prompt...>
                                   Queue a run and print its id
  runs [--project ID]              List recent runs
  show <run-id> [--project ID]     Show a run record
  stop <run-id> [--project ID]     Stop a queued or active run
  answer <standby-id> <go|no>      Answer a waiting Gate

Run from a registered project's directory, or pass --project ID.
Start the daemon with npx cuesheetd before using this client.`;

/** Returns a shell exit code; importing the client has no process side effect. */
export async function runCli(
  args: readonly string[],
  options: CliOptions = {},
): Promise<number> {
  const write = options.output ?? console.log;
  const fail = options.error ?? console.error;
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? hostEnv();
  const variables = options.variables ?? process.env;
  const fetcher = options.fetcher ?? fetch;

  try {
    const [command, ...rest] = args;
    if (command === undefined || command === "help" || command === "--help") {
      write(HELP);
      return 0;
    }
    const parsed = parse(rest);
    if (
      command !== "project" &&
      ![
        "projects",
        "answer",
        "stations",
        "run",
        "runs",
        "show",
        "stop",
      ].includes(command)
    ) {
      throw new CliError(`Unknown command "${command}". Run cuesheet help.`);
    }
    const api = await connect(env, variables, fetcher);

    if (command === "project" && parsed.positionals[0] === "add") {
      if (
        parsed.project !== undefined ||
        parsed.cuesheet !== undefined ||
        parsed.positionals.length > 2
      ) {
        throw new CliError("Usage: cuesheet project add [path]");
      }
      const root = nodePath.resolve(cwd, parsed.positionals[1] ?? ".");
      const { project } = await request<{ project: ListedProject }>(
        api,
        "/projects",
        fetcher,
        { method: "POST", body: JSON.stringify({ root }) },
      );
      write(`${project.id}\t${project.root}`);
      return 0;
    }
    if (command === "projects") {
      noPositionals(parsed);
      if (parsed.project !== undefined) {
        throw new CliError("`projects` lists every project; omit --project.");
      }
      const { projects } = await request<{ projects: ListedProject[] }>(
        api,
        "/projects",
        fetcher,
      );
      for (const project of projects) {
        write(
          `${project.id}\t${project.name}\t${project.status}\t${project.root}`,
        );
      }
      if (projects.length === 0)
        write("No projects. Run `cuesheet project add .`.");
      return 0;
    }
    if (command === "answer") {
      if (parsed.project !== undefined || parsed.cuesheet !== undefined) {
        throw new CliError("`answer` takes only a standby id and go or no.");
      }
      if (
        parsed.positionals.length !== 2 ||
        (parsed.positionals[1] !== "go" && parsed.positionals[1] !== "no")
      ) {
        throw new CliError("Usage: cuesheet answer <standby-id> <go|no>");
      }
      await request(
        api,
        `/standbys/${encodeURIComponent(parsed.positionals[0] ?? "")}`,
        fetcher,
        {
          method: "POST",
          body: JSON.stringify({ answer: parsed.positionals[1] }),
        },
      );
      write(`Answered ${parsed.positionals[0]}: ${parsed.positionals[1]}.`);
      return 0;
    }
    if (command === "project") {
      throw new CliError("Usage: cuesheet project add [path]");
    }
    const project = await selectProject(api, parsed.project, cwd, fetcher);
    const scope = `/projects/${encodeURIComponent(project.id)}`;

    if (command === "stations") {
      noPositionals(parsed);
      const view = await request<{
        stations: { station: { id: string; harness: string; role: string } }[];
        cuesheets: { id: string; stationIds: string[]; gates: string[] }[];
      }>(api, `${scope}/stations`, fetcher);
      for (const { station } of view.stations) {
        write(`${station.id}\t${station.role}\t${station.harness}`);
      }
      for (const sheet of view.cuesheets) {
        write(
          `cuesheet ${sheet.id}\t${sheet.stationIds.join(" → ")}` +
            (sheet.gates.length > 0 ? `\tgate: ${sheet.gates.join(", ")}` : ""),
        );
      }
      return 0;
    }
    if (command === "run") {
      const prompt = parsed.positionals.join(" ").trim();
      if (prompt === "") {
        throw new CliError("Usage: cuesheet run [--cuesheet NAME] <prompt...>");
      }
      const { runId } = await request<{ runId: string }>(
        api,
        `${scope}/runs`,
        fetcher,
        {
          method: "POST",
          body: JSON.stringify({
            prompt,
            ...(parsed.cuesheet !== undefined && { cuesheet: parsed.cuesheet }),
          }),
        },
      );
      write(`Queued ${runId} in ${project.name}.`);
      write(`Inspect it with: cuesheet show ${runId} --project ${project.id}`);
      return 0;
    }
    if (command === "runs") {
      noPositionals(parsed);
      const { runs } = await request<{ runs: Run[] }>(
        api,
        `${scope}/runs`,
        fetcher,
      );
      for (const run of runs) {
        write(`${run.id}\t${run.status}\t${run.prompt.replaceAll("\n", " ")}`);
      }
      if (runs.length === 0) write("No runs yet.");
      return 0;
    }
    if (parsed.positionals.length !== 1 || parsed.cuesheet !== undefined) {
      throw new CliError(`Usage: cuesheet ${command} <run-id>`);
    }
    const runId = encodeURIComponent(parsed.positionals[0] ?? "");
    if (command === "stop") {
      const { outcome } = await request<{ outcome: string }>(
        api,
        `${scope}/runs/${runId}/stop`,
        fetcher,
        { method: "POST" },
      );
      write(`${parsed.positionals[0]}: ${outcome}`);
      return 0;
    }
    const detail = await request<{ run: Run; events: unknown[] }>(
      api,
      `${scope}/runs/${runId}`,
      fetcher,
    );
    write(JSON.stringify(detail, null, 2));
    return detail.run.status === "held" || detail.run.status === "failed"
      ? 1
      : 0;
  } catch (cause) {
    fail(cause instanceof Error ? cause.message : String(cause));
    return 1;
  }
}

interface Parsed {
  positionals: string[];
  project?: string;
  cuesheet?: string;
}

function parse(args: readonly string[]): Parsed {
  const parsed: Parsed = { positionals: [] };
  let literal = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (!literal && arg === "--") {
      literal = true;
    } else if (!literal && (arg === "--project" || arg === "--cuesheet")) {
      const value = args[i + 1];
      if (value === undefined || value === "" || value.startsWith("--")) {
        throw new CliError(`${arg} needs a value.`);
      }
      if (arg === "--project") parsed.project = value;
      else parsed.cuesheet = value;
      i += 1;
    } else if (!literal && arg.startsWith("--")) {
      throw new CliError(`Unknown option ${arg}.`);
    } else {
      parsed.positionals.push(arg);
    }
  }
  return parsed;
}

function noPositionals(parsed: Parsed): void {
  if (parsed.positionals.length > 0 || parsed.cuesheet !== undefined) {
    throw new CliError("This command takes no positional or cuesheet option.");
  }
}

async function connect(
  env: HostEnv,
  variables: NodeJS.ProcessEnv,
  fetcher: typeof fetch,
): Promise<string> {
  let base = variables["CUESHEET_URL"];
  if (base === undefined) {
    let lock: unknown;
    try {
      lock = JSON.parse(await readFile(daemonLockFile(env), "utf8"));
    } catch {
      throw new CliError(
        "Cuesheet is not running. Start it with `npx cuesheetd`.",
      );
    }
    if (
      lock === null ||
      typeof lock !== "object" ||
      typeof (lock as { port?: unknown }).port !== "number" ||
      !Number.isInteger((lock as { port: number }).port) ||
      (lock as { port: number }).port < 1 ||
      (lock as { port: number }).port > 65535
    ) {
      throw new CliError("The daemon lockfile is invalid. Restart cuesheetd.");
    }
    base = `http://127.0.0.1:${(lock as { port: number }).port}`;
  }
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new CliError("CUESHEET_URL must be an HTTP URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CliError("CUESHEET_URL must be an HTTP URL.");
  }
  const origin = url.origin;
  try {
    const response = await fetcher(`${origin}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    const health: unknown = await response.json();
    if (
      !response.ok ||
      health === null ||
      typeof health !== "object" ||
      (health as { ok?: unknown }).ok !== true
    ) {
      throw new Error("not a running Cuesheet daemon");
    }
  } catch {
    throw new CliError(`No Cuesheet daemon answered at ${origin}.`);
  }
  return origin;
}

async function request<T>(
  base: string,
  path: string,
  fetcher: typeof fetch,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(`${base}${path}`, {
      headers: { "content-type": "application/json" },
      ...init,
    });
  } catch (cause) {
    throw new CliError(
      `Cuesheet request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const body: unknown = await response.json();
  if (!response.ok) {
    const message =
      body !== null &&
      typeof body === "object" &&
      typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `${response.status} ${response.statusText}`;
    throw new CliError(message);
  }
  return body as T;
}

async function selectProject(
  api: string,
  requested: string | undefined,
  cwd: string,
  fetcher: typeof fetch,
): Promise<ListedProject> {
  const { projects } = await request<{ projects: ListedProject[] }>(
    api,
    "/projects",
    fetcher,
  );
  if (requested !== undefined) {
    const project = projects.find(({ id }) => id === requested);
    if (project === undefined) {
      throw new CliError(
        `No project named ${requested}. Run cuesheet projects.`,
      );
    }
    if (project.status !== "ok") {
      throw new CliError(
        `Project ${requested} is missing from ${project.root}.`,
      );
    }
    return project;
  }
  let current: string;
  try {
    current = await realpath(cwd);
  } catch {
    throw new CliError(`The current directory no longer exists: ${cwd}`);
  }
  const matches = projects
    .filter((project) => {
      if (project.status !== "ok") return false;
      const relative = nodePath.relative(project.root, current);
      return (
        relative === "" ||
        (relative !== ".." &&
          !relative.startsWith(`..${nodePath.sep}`) &&
          !nodePath.isAbsolute(relative))
      );
    })
    .sort((a, b) => b.root.length - a.root.length);
  const project = matches[0];
  if (project === undefined) {
    throw new CliError(
      "No registered project contains this directory. Run `cuesheet project add .` or pass --project ID.",
    );
  }
  return project;
}
