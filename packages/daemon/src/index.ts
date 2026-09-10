/**
 * `@cuesheet/daemon` — cuesheetd.
 *
 * The daemon is the product: the Desk, the CLI, and later the phone are all
 * just clients of the HTTP surface in `server.ts`. Step 21 imports
 * {@link startDaemon} directly and runs it inside the Electron main process,
 * which is why this package exports a function rather than only a binary.
 */
export { startDaemon } from "./server.js";
export type { StartDaemonOptions, DaemonHandle } from "./server.js";

export { createEventBus, DEFAULT_REPLAY_LIMIT } from "./bus.js";
export type {
  EventBus,
  BusAttachment,
  RunEventListener,
  Unsubscribe,
} from "./bus.js";

export {
  createFileRunStore,
  readEvents,
  RunNotFoundError,
  ZERO_COST,
} from "./store.js";
export type {
  RunStore,
  StoredRun,
  CreateRunInput,
  FinishRunInput,
  RunUpdate,
  FileRunStoreOptions,
} from "./store.js";

export { createRunQueue } from "./queue.js";
export type {
  RunQueue,
  RunQueueOptions,
  EnqueueInput,
  StopOutcome,
} from "./queue.js";

export { noopExecutor } from "./executor.js";
export type {
  RunExecutor,
  ExecutionContext,
  StandbyRequest,
} from "./executor.js";

export { createStandbyRegistry, StandbyAbandonedError } from "./standby.js";
export type { StandbyRegistry, OpenStandby } from "./standby.js";

export { describeStations, unprobed } from "./stations.js";
export type {
  HarnessProber,
  StationView,
  StationsResponse,
} from "./stations.js";

export {
  createRunIdFactory,
  compactStamp,
  isRunId,
  nextRunId,
  RUN_ID_PATTERN,
} from "./ids.js";
export type { RunIdFactory } from "./ids.js";

export {
  currentLock,
  findRunningDaemon,
  PortInUseError,
  probeHealth,
  readLock,
  removeLock,
  writeLock,
} from "./lockfile.js";
export type { DaemonLock, HealthResponse } from "./lockfile.js";

export { DAEMON_VERSION } from "./version.js";
