# Writing a Cuesheet harness

A harness translates a runtime into Cuesheet's probe, usage and run contract.
The daemon owns project scope, permissions, queues, Gates and persistence.
The source of truth is [types.ts](../packages/harness/src/types.ts), with
[contract.ts](../packages/harness/src/contract.ts) providing executable checks.
Read [CONTRIBUTING.md](../CONTRIBUTING.md) for setup and PR expectations.

The packages are currently private npm workspaces. Work in a built checkout;
there is no published SDK installation command or automatic plugin discovery.
An external implementation can be wired into a custom daemon through a registry,
but adding a file or a `harness = "…"` setting alone does not load code.

## Run the smallest example

After `npm ci` and `npm run build`, run:

```bash
node examples/harness/check.mjs
```

The [echo worker](../examples/harness/echo-worker.mjs) implements the public
contract with a deterministic text reply, a worker-only role, no file tools and
no model calls. Its [check script](../examples/harness/check.mjs) runs it against
`exerciseHarness` in a temporary directory, verifies its output and an aborted
invocation, then removes the directory. No vendor login or spend is involved.
It is a teaching example, not a fourth model vendor or a registered built-in.

Copy that example into your own module, or create
`packages/harness/src/my-agent.ts` for a built-in contribution. TypeScript
implementations should use `satisfies Harness`; external code imports the type
from `@cuesheet/harness`, while built-ins use `./types.js` to avoid importing the
barrel that will register them. Use `.js` import specifiers in TypeScript ESM.

## Choose the right existing implementation

| Implementation | Useful for | Boundaries to preserve |
|---|---|---|
| [Claude Code](../packages/harness/src/claude-code.ts) | A CLI with streamed JSON, probe/auth checks and observed rate limits | Engineer/reviewer/caller; `confinement()` reports `none`; external file events are observation |
| [Codex](../packages/harness/src/codex.ts) | A CLI whose sandbox changes with the role | Engineer/reviewer/caller; reviewer/caller (and worker policy) maps to read-only; engineer to workspace-write |
| [Ollama](../packages/harness/src/ollama.ts) | Streaming HTTP completions rather than an agent with tools | Worker-only; reject other roles before inference; no filesystem tools; known marginal cost is zero |
| [Mock](../packages/harness/src/mock.ts) | Exercising events, writes, denials, standbys and reviews without a model | Synthetic usage and results; not evidence of independent real-vendor review |

Do not copy imports from one harness into another. Extract shared mechanics to
a helper such as `observe.ts` or `spawn.ts`.

## Implement each member honestly

| Member | Required behavior |
|---|---|
| `id` | Stable, unique nonempty identifier used in Station config. Registration with an existing id replaces that entry, so check for collisions. |
| `vendor` | Stable provider identity. Gates compare it for `distinct_vendors`; different models or wrappers around the same provider do not earn separate identities. |
| `roles` | Nonempty list of supported roles: `engineer`, `reviewer`, `worker`, `caller`. Declare only seats the implementation can honor. |
| `probe()` | Return installation/auth status and optional version, models, error. Bound subprocess/HTTP waits; report errors instead of throwing or prompting for login. |
| `usage()` | Return `UsageWindow[]`. `[]` means no measured windows, not free or unlimited. Preserve unknown versus measured usage. |
| `contextFiles` | Paths and `project`/`user` scopes the runtime actually loads. `[]` is correct if it loads none. The daemon creates stable Commons projections. |
| `writeConnectors(connectors)` | Register URL or stdio MCP connectors while preserving unrelated user configuration. Be repeatable. A documented no-op is allowed when unsupported. |
| `run(ctx)` | Resolve a `RunResult`, streaming events as work arrives. Honor abort and role permissions. Return `{}` when the adapter can fill all fields. |
| `confinement(role)` | Optional declaration of the runtime's actual sandbox: `read-only`, `workspace-write`, or `none`. Omission means unknown. A prompt asking for read-only behavior is not a sandbox. |

The structural checker validates shape, not truthfulness. The registry itself
does not validate every registration; call `harnessContractViolations(harness)`
in your tests and expect `[]`.

## Run context, files and stop behavior

`ctx.brief` is already assembled; reviewers receive the review brief and diff.
`ctx.station` supplies role, model and leash settings. There is no direct bus,
store, project registry or reference to other Stations in the context.

Use `ctx.workspace.read/write/list/exists/check/diff` for workspace I/O performed
by the harness itself. Do not bypass the facade with `node:fs`. Probe and connector
configuration are separate runtime integration operations; they still must avoid
unrelated writes and preserve existing config. A subprocess's tools cannot be
forced through this facade: set its real sandbox flags from the role, observe
paths where possible, and document what remains unenforced.

Use `ctx.signal` for both a pre-aborted run and an in-flight stop. Pass it to HTTP
requests or the shared subprocess runner. Never swallow an abort and return
success. `ctx.ask(question, "permission" | "hold")` raises a standby and waits
for `"go"` or `"no"`; it does not expand a role's permissions. Respect refusal.

For CLI processes, use the exported `which`, `run`, `jsonLineReader` and
`killTree` helpers from [spawn.ts](../packages/harness/src/spawn.ts). They handle
PATH/PATHEXT, Windows `.cmd` shims, split CRLF lines and process-tree termination.
Use argv arrays and stdin for briefs; never build a `shell: true` command string
from a prompt. Do not require the operator to put model credentials in Cuesheet.

## Streams, cost and review results

**Capture first, map second.** Record a real small run from the exact CLI/runtime
version you target, plus a failure and relevant tool/review cases. Scrub secrets,
private source, home paths and account identifiers, preserving event shapes and
numeric semantics. Commit the fixture and record its runtime version and capture
recipe. Existing [fixtures](../packages/harness/src/fixtures) show the pattern.
Never fabricate a vendor stream or edit a capture to match your mapper.

Harness events are `text`, `tool`, `file`, `denial` and `cost`. The adapter stamps
run id, Station id and time; the queue owns `status`, `standby` and `done`.
Unknown vendor frames should not break a run, but an explicit vendor failure or
nonzero exit must not become success. Test partial lines and multiple chunks.

Use `ctx.meter.record(delta)` for incremental totals; it already emits a cost
event. Do not emit that cost a second time. Alternatively follow an existing
mapper's emitted-cost path consistently and return its authoritative total.
`tokensIn` includes cache reads/writes; those optional fields are a breakdown,
not additional input. Claude's raw input fields are additive, whereas Codex's
cached tokens are a subset of input. Keep that distinction in fixture tests.
Missing `usd` means unknown price; `usd: 0` asserts no marginal charge.

Return a terminal outcome, optional `cost`, `diff`, `verdicts`, and an `error`
when reporting failure. Do not return `running`, `queued` or `standby` as a
completed result. A reviewer can return typed verdicts using
[core's Verdict type](../packages/core/src/types.ts), or stream the structured
review response requested in its brief; see
[the review format](../packages/core/src/verdict.ts). An unreadable review
abstains, and the daemon decides whether the Gate holds. Never turn a generic
"looks good" response into approval inside the harness.

## Register and exercise it

For a built-in, export the module and add its instance to `defaultHarnesses()`
in [index.ts](../packages/harness/src/index.ts). Review
`BUILTIN_HARNESS_IDS` in [core types](../packages/core/src/types.ts) if the built-in
catalog changes. The runtime's registered ids drive the Station picker; do not
add vendor-specific cases to the daemon's executor. Set `harness = "my-agent"`
on a Station whose role and model the new implementation supports.

For an external implementation in a custom daemon entry point:

```ts
import { defaultHarnessRegistry } from "@cuesheet/harness";
import { harnessRuntime, startDaemon } from "@cuesheet/daemon";
import { myAgent } from "./my-agent.js";

const registry = defaultHarnessRegistry();
registry.register(myAgent);
const daemon = await startDaemon({ ...harnessRuntime({ registry }) });
// On process shutdown, await daemon.close().
```

That entry point uses the real profile and port. Contract tests should instead
use a temporary workspace; daemon integration tests must also pass an isolated
`env` and `port: 0`. Use the example's `exerciseHarness` call with your harness,
expect no `violations`, and assert the behavior promised by each supported role.
The helper runs the real harness; against a vendor it can spend money and edit
the supplied workspace. It is a basic contract check, not sandbox certification.

## First harness PR checklist

- Probe covers absent binary/server, signed-out account, timeout and valid setup.
- Offline fixtures cover success, failure, cost/cache semantics and observed tools.
- Unsupported roles refuse before work, and confinement matches real flags/tools.
- Tests cover pre-abort and in-flight stop, refusal, and descendant cleanup for CLIs.
- Workspace tests cover allowed/denied paths; reviewer tests cover valid and unreadable verdicts when that role is supported.
- Context targets and connector behavior are accurate and repeatable.
- Add/register the harness, document installation and supported roles, and update the changelog.
- Run all five root checks; state which live CLI/version and OS checks were actually performed, and which remain unverified.

A third-party production harness proven against this guide remains a separate
1.0 acceptance criterion. The echo example proves the authoring path, not that
external integration milestone.
