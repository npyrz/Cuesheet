/**
 * The daemon half of Step 62's audit: read what each Station loads, and hand
 * `core` the sizes.
 *
 * "What each Station loads" is answered from the same declaration the
 * projector writes through — `Harness.contextFiles` — and at the same places:
 * a project-scoped file under the project root, a user-scoped one under the
 * home directory. The audit therefore measures exactly the files Cuesheet
 * would put a fact or a map into, which is the set it can say something
 * true about. A vendor CLI may also read files nobody declared (ancestor
 * directories, local overrides); those are the vendor's to report, and the
 * route says so rather than guessing at them.
 */
import { readFile } from "node:fs/promises";
import nodePath from "node:path";
import {
  buildContextAudit,
  utf8Bytes,
  type ContextAudit,
  type ContextSource,
  type ContextStationInput,
  type Fact,
  type HarnessId,
  type HostEnv,
  type Ledger,
  type LoadedConfig,
} from "@cuesheet/core";
import type { ContextFile } from "@cuesheet/harness";
import {
  PROJECTION_BEGIN,
  PROJECTION_END,
  renderProjection,
} from "./projections.js";

/**
 * What the audit needs to know about a harness, or `undefined` when this
 * build did not register it. Supplied by `harnessRuntime()`; the default
 * knows nothing, so `startDaemon`'s own tests never depend on a registry.
 */
export type HarnessContext = (
  harness: HarnessId,
) => { vendor: string; contextFiles: readonly ContextFile[] } | undefined;

export const unknownContext: HarnessContext = () => undefined;

export interface ContextAuditOptions {
  config: LoadedConfig;
  projectRoot: string;
  env: HostEnv;
  harnessContext: HarnessContext;
  /** User facts plus this project's, as the executor would read them. */
  memoryFacts: () => Promise<Fact[]>;
  ledger: Ledger;
}

/** The id `core` keys a source by. */
export function sourceId(file: ContextFile): string {
  return `${file.scope}:${file.path}`;
}

/** The brief prefix a harness with no context file is handed instead. */
export const BRIEF_SOURCE_ID = "brief:commons";

export async function auditContext(
  options: ContextAuditOptions,
): Promise<ContextAudit> {
  const stations: ContextStationInput[] = [];
  const declared = new Map<string, ContextFile>();
  let needsBrief = false;

  for (const station of options.config.config.station) {
    const harness = options.harnessContext(station.harness);
    if (harness === undefined) {
      stations.push({ id: station.id, harness: station.harness, loads: null });
      continue;
    }
    // Mirrors `commonsPrefix` in `harness-executor.ts`: no context file of
    // its own means the daemon puts the Commons in the brief. If that rule
    // changes there and not here, this audit undercounts the Station that
    // can least afford it.
    const loads =
      harness.contextFiles.length === 0
        ? [BRIEF_SOURCE_ID]
        : harness.contextFiles.map((file) => {
            declared.set(sourceId(file), file);
            return sourceId(file);
          });
    if (harness.contextFiles.length === 0) needsBrief = true;
    stations.push({
      id: station.id,
      harness: station.harness,
      vendor: harness.vendor,
      loads,
    });
  }

  const sources: ContextSource[] = await Promise.all(
    [...declared.values()].map(async (file) => {
      const root =
        file.scope === "user" ? options.env.homedir : options.projectRoot;
      return fileSource(
        file,
        await readText(nodePath.resolve(root, file.path)),
      );
    }),
  );
  if (needsBrief) {
    const facts = await options.memoryFacts();
    // Byte for byte what `commonsPrefix` assembles, so the two cannot drift
    // apart by a heading.
    const text =
      facts.length === 0
        ? ""
        : `# Cuesheet Commons\n\n${renderProjection(facts)}\n\n`;
    const bytes = utf8Bytes(text);
    sources.push({
      id: BRIEF_SOURCE_ID,
      kind: "brief",
      scope: "project",
      path: "Commons, in the brief",
      exists: bytes > 0,
      bytes,
      // All of it is Cuesheet's: nobody hand-writes a brief prefix.
      generatedBytes: bytes,
    });
  }

  return buildContextAudit({
    sources,
    stations,
    ledger: options.ledger,
  });
}

function fileSource(file: ContextFile, text: string | null): ContextSource {
  const bytes = text === null ? 0 : utf8Bytes(text);
  return {
    id: sourceId(file),
    kind: "file",
    scope: file.scope,
    path: file.path,
    exists: text !== null,
    bytes,
    generatedBytes: text === null ? 0 : generatedBytes(text),
  };
}

/**
 * The size of Cuesheet's block, markers included, or `0` without one.
 *
 * A file with a broken marker pair is reported as wholly hand-written rather
 * than refused: the projector refuses to write it, and the audit is the place
 * somebody would go to find out why the number did not move.
 */
export function generatedBytes(text: string): number {
  const begin = text.indexOf(PROJECTION_BEGIN);
  const end = text.indexOf(PROJECTION_END);
  if (begin === -1 || end === -1 || end < begin) return 0;
  return utf8Bytes(text.slice(begin, end + PROJECTION_END.length));
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return null;
    }
    throw error;
  }
}
