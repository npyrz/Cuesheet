/**
 * The `ollama` harness — a local model, and the first harness of a different
 * shape.
 *
 * `claude-code` and `codex` are agent loops: they plan, run shell commands,
 * apply patches, and emit a structured event stream to map. **Ollama is a
 * completion endpoint.** There is no loop, no patch application, no event
 * taxonomy, and no sandbox flag to hand a role to. Sizing this like the
 * `codex` install — "it is only a missing binary" — would have been the wrong
 * lesson from that phase: the lesson was *check which kind of blocker this
 * is*, not *assume every blocker is environmental*.
 *
 * So this harness is `worker`-only, which is what the README already
 * specifies, and that is a feature rather than a shortfall in two ways:
 *
 * - **No write path at all.** A harness that never writes to a workspace has
 *   no partial-leash story to document. The thing that makes `codex`'s leash
 *   structurally weaker than `claude-code`'s — a subprocess with its own file
 *   tools that never consults our facade — does not arise, because there is
 *   no subprocess and no file tools. The model gets a string and returns a
 *   string.
 * - **The seat is refused rather than warned about.** The README's argument
 *   is a safety one: *"a small local model is not a reviewer. A 7–30B model
 *   reviewing a frontier model's output approves nearly everything, which is
 *   worse than no review because it manufactures confidence."* `run()` below
 *   refuses a seat this harness does not play, before it contacts the model.
 *   The daemon's `/stations` warning (Step 36) is the early, readable half of
 *   that; this is the half that holds when somebody ignores it.
 *
 * ## Two interface firsts, both of which cost something
 *
 * **`probe()` asks whether a server is reachable, not whether a binary is on
 * `PATH`.** Every other probe shells out to a CLI. This one makes an HTTP
 * request, and it has to distinguish *installed but not running* from *not
 * installed* — a state no other harness can be in, and the difference between
 * "start Ollama" and "install Ollama" is the whole value of saying it.
 *
 * **The model list is dynamic.** `/api/tags` reports what is actually pulled
 * on this machine, so `HarnessProbe.models` is populated here and nowhere
 * else. It is also the first list that can go stale between one probe and the
 * next, which is why nothing downstream is allowed to treat it as a check.
 *
 * ## Provenance
 *
 * Written against **captured** streams, the rule Phase 7 set and this file
 * does not get an exception from:
 *
 * - `fixtures/ollama-chat.jsonl` — a real `/api/chat` run on `qwen3:0.6b`,
 *   142 NDJSON frames, thinking and content interleaved, a final `done` frame
 *   with the token counts.
 * - `fixtures/ollama-classify.jsonl` — the same endpoint with `"think":
 *   false`, which arrives as **two** frames. Content is not delivered one
 *   token per frame as a matter of protocol; a mapper fitted to the first
 *   capture alone would not know that.
 * - `fixtures/ollama-error.json` — an unpulled model, which is an HTTP 404
 *   carrying `{"error": "…"}` and no stream at all.
 * - `fixtures/ollama-tags.json` — the `/api/tags` document `probe()` reads.
 *
 * `OLLAMA_HOST` was read out of `ollama serve --help` (0.32.9), which prints
 * it as *"IP Address for the ollama server (default 127.0.0.1:11434)"* —
 * read, not recalled, the same rule that produced `codex.ts`'s flag comments.
 */
import type { Confinement, HarnessProbe, Station } from "@cuesheet/core";
import { jsonLineReader, which } from "./spawn.js";
import type {
  Connector,
  ContextFile,
  Cost,
  Harness,
  HarnessEvent,
  HarnessProbeResult,
  Role,
  RunContext,
  RunResult,
  UsageWindow,
} from "./types.js";

export const OLLAMA_BIN = "ollama";

/**
 * Where Ollama listens unless told otherwise.
 *
 * `127.0.0.1` and not `localhost`, deliberately. On Windows, `localhost`
 * resolves to `::1` first and Node's fetch does not fall back to IPv4 within
 * one request — so a server bound to `0.0.0.0` answers `127.0.0.1` and
 * refuses `localhost`, and the probe would report "not running" about a
 * running server. This is the same gotcha the cross-platform checklist
 * already carries for the daemon's own bind address.
 */
export const OLLAMA_DEFAULT_HOST = "http://127.0.0.1:11434";

/** Long enough for a loopback round trip; short enough not to hang the Desk. */
const PROBE_TIMEOUT_MS = 5_000;

/** The roles this harness will actually play. See the header. */
const OLLAMA_ROLES: readonly Role[] = ["worker"];

export interface OllamaOptions {
  /** Base URL of the server. Defaults to `OLLAMA_HOST`, then to loopback. */
  host?: string;
  /** Override the binary name used to tell "not installed" from "not running". */
  bin?: string;
  /** Injected in tests. Defaults to the global. */
  fetch?: typeof fetch;
  /** Read for `OLLAMA_HOST`. Defaults to the real one. */
  env?: Record<string, string | undefined>;
  /**
   * How the binary is looked up, injected whole rather than as a `PATH`.
   *
   * `which`'s `path` option falls back to the real environment when it is
   * `undefined`, which is right for production and useless for a test: a suite
   * that passed `{}` would silently search the developer's own `PATH` and
   * report "installed" on any machine that happens to have Ollama — which is
   * every machine this harness was written on. Replacing the whole lookup is
   * the only seam that actually isolates it.
   */
  which?: (bin: string) => Promise<string | null>;
}

export function createOllamaHarness(options: OllamaOptions = {}): Harness {
  const bin = options.bin ?? OLLAMA_BIN;
  const env = options.env ?? process.env;
  const doFetch = options.fetch ?? globalThis.fetch;
  const lookup = options.which ?? ((name: string) => which(name));
  const host = (): string => resolveHost(options.host ?? env["OLLAMA_HOST"]);

  /*
   * Empty, and it is the hole Phase 12 exists to fill. The README names it:
   * "Claude Code keeps `CLAUDE.md`, Codex keeps `AGENTS.md`, Ollama keeps
   * nothing." There is no file this runtime reads on its own, so there is
   * nowhere for the Commons to project to — a local model's context has to be
   * assembled into the brief by whoever calls it. Declaring a plausible path
   * here would make the Commons write a file nothing ever reads.
   */
  const contextFiles: readonly ContextFile[] = [];

  return {
    id: "ollama",
    vendor: "ollama",
    roles: OLLAMA_ROLES,

    /*
     * `read-only` is the strongest of the three available answers, and it
     * understates the truth rather than overstating it: this runtime has no
     * file path in either direction, not merely no write path. There is no
     * value for "cannot reach the filesystem at all", and inventing one to
     * describe a single harness would put a fourth case into every surface
     * that renders confinement. `"none"` would be the wrong way to round —
     * that is `claude-code`'s answer and it means "no role-based sandbox",
     * which would read on the Desk as *less* confined than Codex's reviewer
     * when this is in fact more.
     */
    confinement(): Confinement {
      return "read-only";
    },

    async probe(): Promise<HarnessProbeResult> {
      return probeOllama({ host: host(), bin, fetch: doFetch, which: lookup });
    },

    async usage(): Promise<UsageWindow[]> {
      /*
       * The row a percentage cannot describe, and the reason `unmetered` is in
       * `UsageWindow` at all. Until now `mock` was the only harness that could
       * produce it, which meant the limits strip's hardest case was proven
       * against a fake. It is now reachable with a real model behind it.
       *
       * Not conditional on the server being up: a local model has no cap
       * whether or not anyone looked, which is precisely why this variant
       * carries no `seenAt`. "Down" is a liveness fact and `probe()` owns it;
       * answering `unknown` here would confuse the two and make the strip
       * flicker between two true statements about different questions.
       */
      return [{ window: "local", state: "unmetered" }];
    },

    contextFiles,

    async writeConnectors(_connectors: readonly Connector[]): Promise<void> {
      /*
       * Ollama has no MCP client. It serves completions; the tool loop, when
       * there is one, lives in whatever calls it — which here is Cuesheet, and
       * for a `worker` there is no loop to give tools to. Inert rather than
       * absent, so Phase 12 stays additive.
       */
    },

    async run(ctx: RunContext): Promise<RunResult> {
      const refusal = seatRefusal(ctx.station);
      if (refusal !== undefined) {
        /*
         * Refused *before* the request, which is the point. A run that reached
         * the model and then discarded its answer would still have produced
         * one, and the failure mode this guards against is a plausible-looking
         * approval from a model too small to have earned it. Nothing is
         * generated, so there is nothing to mistake for a review.
         */
        ctx.emit({ t: "text", chunk: `${refusal}\n` });
        return {
          status: "failed",
          cost: ctx.meter.total(),
          error: refusal,
        };
      }

      const base = host();
      const model = ctx.station.model;
      if (model === undefined || model.trim() === "") {
        /*
         * No fallback to "the first model pulled". Every other harness takes
         * its model from config and a silent pick here would mean the same
         * Station producing different work on two machines — which is the one
         * thing a dynamic list makes easy to do by accident. The pulled list
         * goes into the *error* instead, where it is actionable.
         */
        const available = await listModels(base, doFetch).catch(() => null);
        return {
          status: "failed",
          cost: ctx.meter.total(),
          error: noModelMessage(ctx.station.id, available),
        };
      }

      const state = createOllamaState();
      const reader = jsonLineReader(
        (value) => {
          for (const event of mapOllamaEvent(value, state)) ctx.emit(event);
        },
        /*
         * Not-JSON becomes text, never an error. `/api/chat` is NDJSON and
         * every captured frame parsed — but a future release printing one
         * unparseable line must degrade to a visible line in the run log, not
         * fail a run that produced good work either side of it.
         */
        (line) => ctx.emit({ t: "text", chunk: `${line}\n` }),
      );

      let response: Response;
      try {
        response = await doFetch(`${base}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            stream: true,
            messages: [{ role: "user", content: ctx.brief }],
          }),
          signal: ctx.signal,
        });
      } catch (error) {
        if (isAbort(error) || ctx.signal.aborted) {
          return { status: "stopped", cost: ctx.meter.total() };
        }
        return {
          status: "failed",
          cost: ctx.meter.total(),
          error: unreachable(base, error),
        };
      }

      if (!response.ok) {
        /*
         * An unpulled model is a 404 with a JSON body and no stream — captured
         * in `ollama-error.json`. It is reported as a failed *run* rather than
         * thrown, so the record says what happened and the Desk shows the
         * sentence Ollama wrote instead of a stack.
         */
        return {
          status: "failed",
          cost: ctx.meter.total(),
          error: await errorBody(response, model),
        };
      }

      try {
        for await (const chunk of textChunks(response)) reader.push(chunk);
        reader.flush();
      } catch (error) {
        if (isAbort(error) || ctx.signal.aborted) {
          /*
           * Whatever the model said before the stop is already on the record —
           * the events were emitted as they arrived — and the tokens spent are
           * already metered. A stop is not a failure.
           */
          return { status: "stopped", cost: settle(ctx, state) };
        }
        return {
          status: "failed",
          cost: settle(ctx, state),
          error: `The stream from \`${model}\` ended early: ${text(error)}`,
        };
      }

      if (ctx.signal.aborted) {
        return { status: "stopped", cost: settle(ctx, state) };
      }

      if (state.errorMessage !== undefined) {
        return {
          status: "failed",
          cost: settle(ctx, state),
          error: state.errorMessage,
        };
      }

      /*
       * No `diff`, and not because there is nothing to report. A worker that
       * returned `ctx.workspace.diff()` would attribute somebody else's
       * changes in a shared workspace to the one Station that cannot make
       * any — the same reasoning `mock`'s worker branch carries, and it
       * matters more here because this harness *cannot* write even in
       * principle, so any diff it reported would be provably not its own.
       */
      return { status: "done", cost: settle(ctx, state) };
    },
  };
}

/** The default instance, registered by `defaultHarnesses()`. */
export const ollamaHarness: Harness = createOllamaHarness();

// ── Probing ─────────────────────────────────────────────────────────────────

interface ProbeDeps {
  host: string;
  bin: string;
  fetch: typeof fetch;
  which: (bin: string) => Promise<string | null>;
}

/**
 * Three outcomes, and the middle one is why this function exists.
 *
 * Every other probe has two states — the binary is there or it is not.
 * Ollama has a third: installed, on the PATH, and nothing listening, which is
 * the ordinary state of a machine that has just booted. Collapsing it into
 * "not installed" would tell an operator to download something they already
 * have; collapsing it into "not running" would tell someone with no Ollama to
 * start a service that does not exist.
 *
 * The server is asked *first*, and the binary only when it does not answer.
 * A remote `OLLAMA_HOST` is a supported configuration and there is no binary
 * on this machine in that case — probing the PATH first would report a
 * perfectly good remote server as uninstalled.
 */
export async function probeOllama(
  deps: ProbeDeps,
): Promise<HarnessProbeResult> {
  const version = await serverVersion(deps.host, deps.fetch);

  if (version.reachable) {
    /*
     * `authed: true` with nothing to log into. Ollama has no credential — a
     * reachable local server is as authed as it gets, and reporting `false`
     * would light up every "needs sign-in" affordance the Desk has for a
     * runtime that has no sign-in. `signin` exists on the CLI for pushing
     * models to ollama.com, which is not a thing a run needs.
     */
    const models = await listModels(deps.host, deps.fetch).catch(() => null);
    return {
      installed: true,
      authed: true,
      ...(version.version !== undefined && { version: version.version }),
      binPath: deps.host,
      // `[]` is a real answer — a running server with nothing pulled — and is
      // reported as such. Only a *failed* `/api/tags` leaves it absent.
      ...(models !== null && { models }),
      ...(models === null && {
        error: `\`${deps.host}/api/tags\` did not answer, so no model list.`,
      }),
    };
  }

  const binPath = await deps.which(deps.bin);
  if (binPath !== null) {
    return {
      installed: true,
      authed: false,
      binPath,
      error: `Ollama is installed but nothing is listening on ${deps.host} — start it with \`${deps.bin} serve\`.`,
    };
  }

  return {
    installed: false,
    authed: false,
    error:
      `\`${deps.bin}\` is not on your PATH and nothing is listening on ${deps.host}. ` +
      `Install Ollama, or point \`OLLAMA_HOST\` at a machine that is running it.`,
  };
}

interface ServerVersion {
  reachable: boolean;
  version?: string;
}

/**
 * `GET /api/version` → `{"version":"0.32.9"}`.
 *
 * Chosen over `/api/tags` for the liveness question because it is the smaller
 * document and it answers on a server with nothing pulled. Never throws: a
 * probe that throws takes down `GET /stations` for every other harness too.
 */
async function serverVersion(
  host: string,
  doFetch: typeof fetch,
): Promise<ServerVersion> {
  try {
    const response = await doFetch(`${host}/api/version`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return { reachable: false };
    const body: unknown = await response.json();
    const record = asRecord(body);
    const version = record?.["version"];
    return {
      reachable: true,
      ...(typeof version === "string" && { version }),
    };
  } catch {
    // Connection refused, DNS failure, or the timeout above. All of them mean
    // the same thing to a caller: no server answered here.
    return { reachable: false };
  }
}

/**
 * `GET /api/tags` → what is pulled on this machine, newest field set aside.
 *
 * Rejects rather than returning `[]` on failure, because the caller has to be
 * able to tell "nothing is pulled" from "I could not ask" — that distinction
 * is the whole reason `HarnessProbe.models` is optional.
 */
export async function listModels(
  host: string,
  doFetch: typeof fetch = globalThis.fetch,
): Promise<string[]> {
  const response = await doFetch(`${host}/api/tags`, {
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `\`${host}/api/tags\` returned ${String(response.status)}.`,
    );
  }
  return parseTags(await response.json());
}

/**
 * Pull the model names out of a `/api/tags` document.
 *
 * `name` rather than `model`: the captured document carries both and they are
 * equal (`qwen3:0.6b`), but `name` is the one the `model` field of a request
 * is documented against and the one `ollama list` prints. Sorted, because the
 * server returns them by modification time and a picker that reorders itself
 * every time somebody pulls something is a picker people misclick.
 */
export function parseTags(body: unknown): string[] {
  const record = asRecord(body);
  const models = record === null ? null : record["models"];
  if (!Array.isArray(models)) return [];
  const names: string[] = [];
  for (const entry of models) {
    const model = asRecord(entry);
    const name = model?.["name"] ?? model?.["model"];
    if (typeof name === "string" && name !== "") names.push(name);
  }
  return names.sort((a, b) => a.localeCompare(b));
}

/**
 * Normalise whatever `OLLAMA_HOST` holds into a base URL.
 *
 * The CLI's own help calls it an "IP Address … (default 127.0.0.1:11434)", and
 * a bare `host:port` is what people actually set, so a scheme is added when
 * one is missing. A trailing slash is stripped so the paths below concatenate
 * without doubling it.
 */
export function resolveHost(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (value === "") return OLLAMA_DEFAULT_HOST;
  const withScheme = /^https?:\/\//i.test(value) ? value : `http://${value}`;
  return withScheme.replace(/\/+$/, "");
}

// ── The seat ────────────────────────────────────────────────────────────────

/**
 * Why this Station may not run here, or `undefined` if it may.
 *
 * The structural half of the README's safety argument. `roles` is a claim the
 * daemon reads to *warn* at `GET /stations`; this is the same claim enforced
 * at the only moment that cannot be skipped. They are not redundant: the
 * warning is what an operator sees while writing config, and this is what
 * happens to the operator who did not read it.
 */
export function seatRefusal(station: Station): string | undefined {
  if (OLLAMA_ROLES.includes(station.role)) return undefined;
  return (
    `Station "${station.id}" asks \`ollama\` to be a ${station.role}, and this harness only plays worker. ` +
    `A small local model reviewing a frontier model's output approves nearly everything, ` +
    `which is worse than no review because it manufactures confidence. ` +
    `Point this Station at \`claude-code\` or \`codex\`, or give it \`role = "worker"\`.`
  );
}

function noModelMessage(
  stationId: string,
  available: readonly string[] | null,
): string {
  const head = `Station "${stationId}" has no \`model\`, and \`ollama\` cannot pick one for you.`;
  if (available === null) return head;
  if (available.length === 0) {
    return `${head} Nothing is pulled on this machine either — try \`ollama pull qwen3:0.6b\`.`;
  }
  return `${head} Pulled here: ${available.join(", ")}.`;
}

// ── Stream mapping ──────────────────────────────────────────────────────────

export interface OllamaState {
  /** Set when the stream itself reported a problem. */
  errorMessage?: string;
  total(): Cost;
}

interface InternalState extends OllamaState {
  tokensIn: number;
  tokensOut: number;
  /** Whether a `done` frame ever arrived with counts on it. */
  settled: boolean;
}

export function createOllamaState(): OllamaState {
  const state: InternalState = {
    tokensIn: 0,
    tokensOut: 0,
    settled: false,
    total(): Cost {
      /*
       * `usd: 0` — and this is the one harness where a zero is a fact rather
       * than a guess. `meter.ts` says an absent price "means the harness could
       * not price it, which is not the same claim as 'it cost nothing'";
       * `codex` leaves it absent for exactly that reason. Local inference has
       * no marginal price, so the claim here is the strong one, and a ledger
       * that showed a local worker as "cost unknown" would be understating
       * what it knows.
       *
       * No `cacheRead` or `cacheWrite`. Nothing in either capture reports a
       * cache, and a zero would claim this runtime never uses one.
       */
      return { tokensIn: state.tokensIn, tokensOut: state.tokensOut, usd: 0 };
    },
  };
  return state;
}

/**
 * Map one NDJSON frame onto zero or more `HarnessEvent`s.
 *
 * Exported and pure apart from the accumulator it is handed, so the mapper is
 * tested against the captured streams with no server anywhere near it.
 */
export function mapOllamaEvent(
  value: unknown,
  state: OllamaState,
): HarnessEvent[] {
  const s = state as InternalState;
  const frame = asRecord(value);
  if (frame === null) return [];

  /*
   * An `error` key on a frame. The *shape* is captured — `ollama-error.json`
   * is `{"error": "model 'not-a-real-model:7b' not found"}` — but that arrived
   * as a 404 body, not mid-stream, and no capture here produced one inside a
   * live stream. So this is a degradation path rather than a documented one:
   * if a frame ever says `error`, the message reaches the operator and the run
   * fails, instead of the key being silently dropped into `default`.
   */
  const error = frame["error"];
  if (typeof error === "string" && error.trim() !== "") {
    s.errorMessage ??= error;
    return [{ t: "text", chunk: `${error}\n` }];
  }

  const events: HarnessEvent[] = [];
  const message = asRecord(frame["message"]);
  if (message !== null) {
    const content = message["content"];
    if (typeof content === "string" && content !== "") {
      /*
       * Emitted exactly as it arrives, with no newline added. Ollama streams
       * fragments of words — `"Add"`, `" rate"`, `" limiter"` — and the run
       * log stitches them back together; a newline per frame would render the
       * first capture as 142 lines of one word each. The two captures differ
       * here and both are normal: 142 frames with thinking on, two with it
       * off, which is why nothing below may assume a frame is a line.
       */
      events.push({ t: "text", chunk: content });
    }

    /*
     * `thinking` is dropped, exactly as `codex.ts` drops `reasoning` and
     * `claude-code.ts` drops `thinking` blocks. It is the model's scratchpad,
     * it is long — 618 characters of it in the captured run, to produce a
     * 32-character commit line — and the run log is meant to be readable at a
     * glance.
     *
     * The tokens are still counted. `eval_count` on the final frame is 146
     * against 32 characters of content, so the scratchpad is plainly inside
     * it, and a worker's cost is what it cost.
     *
     * `"think": false` in the request body would suppress it at the source and
     * was captured working on `qwen3:0.6b`. It is deliberately **not** sent:
     * it has only been verified against a thinking-capable model, and no
     * non-thinking model was on this machine to see what one does with the
     * flag. Sending an unverified flag to every model is the failure mode
     * `codex.ts`'s "read the help, do not recall it" rule exists to prevent.
     */
  }

  if (frame["done"] === true) return [...events, ...settleFrame(frame, s)];
  return events;
}

/**
 * The final frame carries the authoritative counts.
 *
 * **These are counts of the whole turn, not deltas**, and they arrive once —
 * both captures agree. `prompt_eval_count` is input, `eval_count` is output,
 * and `eval_count` includes the thinking tokens the mapper just dropped.
 *
 * The durations (`total_duration`, `load_duration`, `eval_duration`) are
 * nanoseconds and are not mapped. There is no event for wall time, the run
 * record already stamps its own, and `load_duration` in particular describes
 * how long the model took to page into memory — a property of the machine
 * that run happened on, not of the work.
 */
function settleFrame(
  frame: Record<string, unknown>,
  state: InternalState,
): HarnessEvent[] {
  state.tokensIn = numberAt(frame, "prompt_eval_count");
  state.tokensOut = numberAt(frame, "eval_count");
  state.settled = true;

  /*
   * `done_reason` is reported when it is not `"stop"`. `"length"` means the
   * model hit its context window and the answer is truncated — which for a
   * worker whose whole output is one classification is the difference between
   * an answer and half of one, and it must not look like a clean finish.
   */
  const reason = frame["done_reason"];
  const events: HarnessEvent[] = [];
  if (typeof reason === "string" && reason !== "" && reason !== "stop") {
    events.push({
      t: "text",
      chunk: `\n[the model stopped early: ${reason}]\n`,
    });
  }

  /*
   * **No `cost` event from here.** The counts are recorded on `state`, and
   * `settle()` hands them to the meter — which emits the one `cost` event for
   * the run. Emitting one here as well put the same figure on the wire twice,
   * which the first real run through the daemon showed plainly: two identical
   * `cost` events, a millisecond apart, against one settlement.
   *
   * The totals were never wrong — `reconcileCost` prefers a harness's returned
   * total over the summed stream — but a Desk that draws the stream would have
   * rendered a local run as costing twice what it did, and the one thing a
   * free harness must not do is look expensive.
   *
   * `codex.ts` does the opposite, pushing events through `drainCost` and never
   * touching the meter, and both are valid. What is not valid is doing both,
   * which is what happens if you copy half of one pattern.
   */
  return events;
}

// ── Small helpers ───────────────────────────────────────────────────────────

/**
 * Hand the mapper's totals to the meter, then take the meter's word for it.
 *
 * One settlement, at the end, rather than `meter.record` per frame: the counts
 * only exist on the final frame, so there is nothing to record until then.
 * Going through the meter at all — rather than returning `state.total()` —
 * keeps the `cost` event and the recorded total flowing through the one place
 * that adds them up, which is what `reconcileCost` expects to reconcile.
 */
function settle(ctx: RunContext, state: OllamaState): Cost {
  const totals = state.total();
  ctx.meter.record({
    tokensIn: totals.tokensIn,
    tokensOut: totals.tokensOut,
    usd: 0,
  });
  return ctx.meter.total();
}

/** The response body as text chunks, whatever the runtime gives us. */
async function* textChunks(response: Response): AsyncGenerator<string> {
  const body = response.body;
  if (body === null) {
    // A 200 with no body is not a shape any capture produced, but `body` is
    // nullable on the type and a thrown TypeError here would surface as a
    // crash rather than as a run that produced nothing.
    const text_ = await response.text();
    if (text_ !== "") yield text_;
    return;
  }
  const decoder = new TextDecoder();
  // `for await` over the body rather than a manual reader loop: it releases
  // the lock on abort, which is what lets a stopped run stop cleanly.
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    yield decoder.decode(chunk, { stream: true });
  }
  const tail = decoder.decode();
  if (tail !== "") yield tail;
}

/** The sentence Ollama wrote, when it wrote one. */
async function errorBody(response: Response, model: string): Promise<string> {
  const fallback = `\`${model}\` was refused: HTTP ${String(response.status)}.`;
  try {
    const body: unknown = await response.json();
    const error = asRecord(body)?.["error"];
    return typeof error === "string" && error.trim() !== "" ? error : fallback;
  } catch {
    return fallback;
  }
}

function unreachable(host: string, error: unknown): string {
  return (
    `Could not reach Ollama at ${host} — ${text(error)}. ` +
    `Start it with \`${OLLAMA_BIN} serve\`, or set \`OLLAMA_HOST\`.`
  );
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberAt(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Re-exported for the daemon's `/stations` route. */
export type { HarnessProbe };
