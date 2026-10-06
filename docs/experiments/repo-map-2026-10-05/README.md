# Repo-map measurement — 2026-10-05

Step 59's remaining acceptance criterion is now measured: on two tasks in the
same small synthetic repository, fresh Claude Code sessions with Cuesheet's map
made **two tool calls before their first edit**, compared with **three without it**.
Both treatments produced correct fixes. This is evidence of a discovery-call
saving on this fixture, not a general estimate of production savings.

| Task | Order | Unmapped calls before edit | Mapped calls before edit | Unmapped total calls | Mapped total calls |
|---|---|---:|---:|---:|---:|
| Previous UTC calendar month, including year rollover | Unmapped, mapped | 3 | 2 | 6 | 5 |
| Trim and deduplicate contact labels without mutating inputs | Mapped, unmapped | 3 | 2 | 6 | 5 |

The unmapped sequence was `Grep, Read, Read, Edit` in both runs. The mapped
sequence was `Read, Read, Edit`: the agent opened the target source and its
colocated test directly. The first edit was successful in each captured stream.
The edit itself is excluded from the pre-edit count. Unique tool-use IDs are
counted individually, including multiple calls in one assistant message; failed
calls would also count before the first successful edit.

## Controls and verification

- Windows, Node `v24.19.0`, Claude Code `2.1.221`, reported model
  `claude-sonnet-5` in all four runs. The source revision and exact CLI flags,
  prompts and fixture SHA-256 are in [manifest.json](manifest.json).
- Every run started a new CLI process in a new scratch repository with the
  same 20 JavaScript source/test files, package file and operator instructions.
  Each pair used exactly the same prompt. No session was resumed or persisted.
  Settings sources were restricted to the project, MCP configuration was strict
  and empty, and the six available built-in tools were the same in every run.
- The only input difference was the production mapper's output, assembled by
  the production `renderProjection` and appended to `CLAUDE.md`. The map was
  950 UTF-8 bytes, with no omitted files; the projection added 998 bytes in total
  (about 250 estimated tokens). The context files beside the captures preserve
  exactly what each run received. Rendering twice before each session produced
  byte-identical maps.
- Treatment order was reversed for the second task. "Cold" means a fresh
  session and workspace; vendor prompt-cache state was not controlled. The
  captures retain the vendor's usage/cache figures so this limitation is visible.
- After each session, the script ran `node --test` independently, then additional
  assertions the agent had not seen. Those checked year rollover and leap-year
  February for the calendar task; trimming, blank removal, case-insensitive
  deduplication, order, preserved spelling and input immutability for labels.
  All four passed. Fewer calls from an incorrect fix would fail the experiment.

The four CLI results reported a combined usage-equivalent cost of $0.410481.
These were subscription runs; that figure is the CLI's reported valuation, not
a cash charge. Two pairs do not establish a dollar saving, a latency saving,
statistical significance, or the result on larger repositories or other vendors.
The map remains off by default for the tracked-file churn reason in the plan.

## Evidence and reproduction

The `.jsonl` files contain the received tool-use/result blocks plus model/version
and final usage/result fields. Scratch paths are replaced with `{{WORKSPACE}}`;
account/session IDs, machine inventory and unrelated narrative were omitted.
The captured tool inputs and results have not been rewritten to match the result.

To verify the counts and successful results without starting a model:

```sh
npm run build
node scripts/measure-repo-map.mjs --replay docs/experiments/repo-map-2026-10-05
```

To repeat the experiment, choose a new output directory:

```sh
node scripts/measure-repo-map.mjs --run docs/experiments/repo-map-repeat
```

`--run` uses the logged-in operator's Claude plan for four sessions, each with
a $1 CLI budget and a three-minute process timeout. Existing output directories
are refused. Scratch repositories are retained in the system temp directory for
inspection. Live runs are deliberately outside CI.
