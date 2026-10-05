/** Read-only estimates of declared context, never a vendor bill. */
export interface ContextLoadAuditFile {
  path: string;
  scope: "project" | "user";
  stationIds: string[];
  state: "present" | "missing" | "unreadable";
  bytes: number | null;
  estimatedTokens: number | null;
  /** Included in estimatedTokens, not additional to it. */
  projectionEstimatedTokens: number | null;
  error?: string;
}

export interface ContextLoadAuditStation {
  id: string;
  harness: string;
  filePaths: string[];
  estimatedTokens: number;
  complete: boolean;
  reason?: string;
}

export interface ContextLoadAuditPlan {
  /** null is the ordinary run (the first configured Station). */
  cuesheet: string | null;
  stationIds: string[];
  estimatedTokensPerRun: number;
  estimatedTokens: number;
  complete: boolean;
}

export interface ContextLoadAudit {
  runs: number;
  files: ContextLoadAuditFile[];
  stations: ContextLoadAuditStation[];
  plans: ContextLoadAuditPlan[];
  /** One invocation of every configured Station; not the default run. */
  estimatedTokensAcrossStations: number;
  complete: boolean;
  notes: string[];
}
