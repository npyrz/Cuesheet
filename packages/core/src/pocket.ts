import type { Standby } from "./types.js";

/** The remote surface deliberately has no workspace paths, logs or patches. */
export interface PocketStandby {
  id: string;
  runId: string;
  project: string;
  station: string | null;
  kind: Standby["kind"];
  ask: string;
  at: string;
}

export interface PocketDevice {
  id: string;
  name: string;
  expiresAt: string;
}

export interface PocketStatus {
  enabled: boolean;
  origin: string | null;
  port: number | null;
  devices: PocketDevice[];
  error: string | null;
}

export interface PocketInvitation {
  url: string;
  expiresAt: string;
}
