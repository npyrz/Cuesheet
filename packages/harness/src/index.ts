/**
 * `@cuesheet/harness` — the interface, the registry, and the built-ins.
 *
 * The one import a harness author needs. The README's example opens with
 * `import type { Harness, RunContext, RunResult } from "@cuesheet/harness"`
 * and that line has to keep working for people whose harness lives in their
 * own repo.
 */
export type {
  Harness,
  HarnessEvent,
  HarnessEventType,
  HarnessProbeResult,
  RunContext,
  RunResult,
  Workspace,
  LeashCheck,
  DiffResult,
  Meter,
  CostDelta,
  UsageWindow,
  ContextFile,
  Connector,
} from "./types.js";
export { LeashDeniedError } from "./types.js";

export { createHarnessRegistry } from "./registry.js";
export type { HarnessRegistry } from "./registry.js";

export { createWorkspace, NoWorkspaceError } from "./workspace.js";
export type { WorkspaceOptions } from "./workspace.js";

export { createMeter } from "./meter.js";
export type { MeterOptions } from "./meter.js";

export { harnessContractViolations, exerciseHarness } from "./contract.js";
export type { ExerciseOptions, ExerciseReport } from "./contract.js";

export {
  which,
  run,
  killTree,
  lineReader,
  jsonLineReader,
  SpawnError,
  DEFAULT_PATHEXT,
} from "./spawn.js";
export type {
  LookupEnv,
  SpawnOptions,
  SpawnResult,
  LineReader,
} from "./spawn.js";

export { diffWorkspace, isGitRepo, parseNumstat, EMPTY_DIFF } from "./git.js";
export type { GitDiffOptions } from "./git.js";

export {
  createMockHarness,
  mockHarness,
  MOCK_OUTPUT_FILE,
  MOCK_DENIED_FILE,
} from "./mock.js";
export type { MockHarnessOptions } from "./mock.js";

export {
  createClaudeCodeHarness,
  claudeCodeHarness,
  claudeConnectorArgs,
  buildArgs,
  parseVersion,
  mapStreamEvent,
  mapRateLimit,
  createStreamState,
  CLAUDE_BIN,
} from "./claude-code.js";
export type { ClaudeCodeOptions, StreamState } from "./claude-code.js";

export {
  createCodexHarness,
  codexHarness,
  codexConnectorArgs,
  buildArgs as buildCodexArgs,
  parseVersion as parseCodexVersion,
  mapCodexEvent,
  createCodexState,
  sandboxFor,
  isTransportNoise,
  unwrap,
  CODEX_BIN,
} from "./codex.js";
export type { CodexOptions, CodexState } from "./codex.js";

export {
  createOllamaHarness,
  ollamaHarness,
  createOllamaState,
  mapOllamaEvent,
  parseTags,
  listModels,
  probeOllama,
  resolveHost,
  seatRefusal,
  OLLAMA_BIN,
  OLLAMA_DEFAULT_HOST,
} from "./ollama.js";
export type { OllamaOptions, OllamaState } from "./ollama.js";

export { observedStation } from "./observe.js";

import { claudeCodeHarness } from "./claude-code.js";
import { codexHarness } from "./codex.js";
import { mockHarness } from "./mock.js";
import { ollamaHarness } from "./ollama.js";
import { createHarnessRegistry, type HarnessRegistry } from "./registry.js";
import type { Harness } from "./types.js";

/**
 * The harnesses this build ships with.
 *
 * `mock` first, and it stays shipped rather than being a test fixture: it is
 * how someone with no agent CLI installed can still open the app, add a
 * Station, and watch the Desk work. A first run that shows nothing because
 * nothing is installed is a worse introduction than a fake one that moves.
 *
 * `claude-code` and `codex` are both here because a Gate's `distinct_vendors`
 * is an equality check over `vendor`. Shipping one real harness made Gates
 * demonstrable but not usable; shipping two from different vendors is what
 * makes the README's own example satisfiable without the operator installing
 * anything beyond the CLIs they already have.
 *
 * `ollama` costs nothing to register on a machine that does not have it: its
 * probe is an HTTP request to loopback that refuses in milliseconds, where the
 * other two shell out to a binary. It is also the only one whose absence used
 * to be reported as "a harness nobody registered" — `BUILTIN_HARNESS_IDS` has
 * listed it since Step 5, and until now `GET /stations` had to say so.
 */
export function defaultHarnesses(): Harness[] {
  return [mockHarness, claudeCodeHarness, codexHarness, ollamaHarness];
}

export function defaultHarnessRegistry(): HarnessRegistry {
  return createHarnessRegistry(defaultHarnesses());
}
