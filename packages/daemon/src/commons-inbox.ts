/**
 * The approval boundary between an agent capture and the Commons.
 *
 * Pending memories live outside the Git-backed store. That separation is not
 * cosmetic: the store stages with `git add -A`, so an `inbox/` directory under
 * it would be committed by the next approved write and become durable memory
 * before a person had accepted it. Projections only read `CommonsStore`, and
 * therefore have no route to these files.
 */
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import nodePath from "node:path";
import {
  commonsInboxDir,
  hostEnv,
  isFactId,
  slugify,
  type FactProvenance,
  type HostEnv,
  type PendingMemory,
} from "@cuesheet/core";

export interface CaptureMemoryInput {
  title: string;
  body: string;
  tags?: string[];
  projects?: string[];
  station: string;
  run: string;
}

export interface CommonsInboxOptions {
  env?: HostEnv;
  /** Tests pass an isolated root so no capture reaches the real inbox. */
  root?: string;
  now?: () => Date;
  idFactory?: () => string;
}

export interface CommonsInbox {
  readonly root: string;
  list(): Promise<PendingMemory[]>;
  get(id: string): Promise<PendingMemory | null>;
  capture(input: CaptureMemoryInput): Promise<PendingMemory>;
  discard(id: string): Promise<PendingMemory | null>;
  /** Remove only after `action` succeeds; a failed approval remains retryable. */
  resolve<T>(
    id: string,
    action: (memory: PendingMemory) => Promise<T>,
  ): Promise<T | null>;
}

export class CommonsInboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommonsInboxError";
  }
}

export function createCommonsInbox(
  options: CommonsInboxOptions = {},
): CommonsInbox {
  const env = options.env ?? hostEnv();
  const root = options.root ?? commonsInboxDir(env);
  const now = options.now ?? (() => new Date());
  const makeId = options.idFactory ?? (() => `memory-${randomUUID()}`);
  let chain: Promise<unknown> = Promise.resolve();

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = chain.then(work, work);
    chain = result.catch(() => undefined);
    return result;
  }

  function fileFor(id: string): string {
    if (!isFactId(id)) {
      throw new CommonsInboxError(`"${id}" is not a pending memory id.`);
    }
    return nodePath.join(root, `${id}.json`);
  }

  async function read(id: string): Promise<PendingMemory | null> {
    try {
      return parsePending(await readFile(fileFor(id), "utf8"), id);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async function remove(id: string): Promise<PendingMemory | null> {
    const memory = await read(id);
    if (memory === null) return null;
    await rm(fileFor(id), { force: true });
    return memory;
  }

  return {
    root,

    list: () =>
      enqueue(async () => {
        let names: string[];
        try {
          names = await readdir(root);
        } catch (error) {
          if (isMissing(error)) return [];
          throw error;
        }
        const pending: PendingMemory[] = [];
        for (const name of names.sort()) {
          if (!name.endsWith(".json")) continue;
          const id = name.slice(0, -5);
          if (!isFactId(id)) continue;
          try {
            pending.push(parsePending(await readFile(fileFor(id), "utf8"), id));
          } catch {
            // One hand-edited or interrupted draft cannot hide every other
            // item that still needs a decision.
          }
        }
        return pending.sort((left, right) => {
          const byTime =
            left.provenance.at < right.provenance.at
              ? 1
              : left.provenance.at > right.provenance.at
                ? -1
                : 0;
          if (byTime !== 0) return byTime;
          return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
        });
      }),

    get: (id) => enqueue(() => read(id)),

    capture: (input) =>
      enqueue(async () => {
        await mkdir(root, { recursive: true });
        let id: string | null = null;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const candidate = makeId();
          if (!isFactId(candidate)) {
            throw new CommonsInboxError(
              `The pending memory id factory produced "${candidate}".`,
            );
          }
          if ((await read(candidate)) === null) {
            id = candidate;
            break;
          }
        }
        if (id === null) {
          throw new CommonsInboxError(
            "Could not allocate a pending memory id.",
          );
        }

        const provenance: FactProvenance = {
          station: input.station,
          run: input.run,
          at: now().toISOString(),
        };
        const memory: PendingMemory = {
          id,
          suggestedId: slugify(input.title),
          title: input.title,
          body: input.body,
          tags: input.tags ?? [],
          projects: input.projects ?? [],
          provenance,
        };
        const target = fileFor(id);
        const temporary = `${target}.tmp`;
        await writeFile(
          temporary,
          `${JSON.stringify(memory, null, 2)}\n`,
          "utf8",
        );
        await rename(temporary, target);
        return memory;
      }),

    discard: (id) => enqueue(() => remove(id)),

    resolve: (id, action) =>
      enqueue(async () => {
        const memory = await read(id);
        if (memory === null) return null;
        const result = await action(memory);
        await rm(fileFor(id), { force: true });
        return result;
      }),
  };
}

function parsePending(text: string, expectedId: string): PendingMemory {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CommonsInboxError(`${expectedId}.json is not an object.`);
  }
  const record = value as Record<string, unknown>;
  const provenance = record["provenance"];
  if (
    record["id"] !== expectedId ||
    typeof record["title"] !== "string" ||
    typeof record["body"] !== "string" ||
    !strings(record["tags"]) ||
    !strings(record["projects"]) ||
    (record["suggestedId"] !== null && !isFactId(record["suggestedId"])) ||
    provenance === null ||
    typeof provenance !== "object" ||
    Array.isArray(provenance)
  ) {
    throw new CommonsInboxError(`${expectedId}.json is not a pending memory.`);
  }
  const source = provenance as Record<string, unknown>;
  if (
    typeof source["station"] !== "string" ||
    typeof source["run"] !== "string" ||
    typeof source["at"] !== "string"
  ) {
    throw new CommonsInboxError(
      `${expectedId}.json has no capture provenance.`,
    );
  }
  return value as PendingMemory;
}

function strings(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    (error as { code?: string }).code === "ENOENT"
  );
}
