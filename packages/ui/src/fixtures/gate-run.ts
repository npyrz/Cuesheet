/**
 * The Phase 7 gate run, as a record this surface can replay.
 *
 * **This is a reconstruction, and saying so is part of the point.** The
 * original run happened on a real repo with both CLIs billed, and its record
 * lived in `~/.cuesheet` on the machine that ran it. That directory does not
 * exist any more, so the run itself cannot be replayed — what survives is the
 * transcript recorded in PLAN-STEP.MD under Step 30, and this file is that
 * transcript typed back into the shapes the Desk consumes.
 *
 * Everything here comes from that record and nothing is invented: the prompt,
 * the two Stations and their vendors, the `+22 −1` on `upload.js`, the
 * reviewer's security finding, the gate's two reasons, `$0.5552`, `2m 51s`,
 * and the `held` status. The one thing it cannot reproduce is the prose the
 * two agents streamed, which was never written down — so the text events are
 * the two lines the transcript does quote.
 *
 * It exists because Step 43's done-when is measured on *this* run, and a
 * surface tested only on synthetic events is a surface tested on what its
 * author expected. The stronger half of the evidence is a live held gate run
 * driven through the daemon with two mock vendors; this is the half that
 * carries the real shapes — two vendors, a `pass`-with-a-blocking-finding
 * reviewer, and a Gate that held for two separate reasons.
 */
import type { Run, RunEvent, RunId, Verdict } from "@cuesheet/core";

const RUN_ID = "20260731T101500000Z-0001" as RunId;
const AT = (seconds: number): string =>
  new Date(
    Date.parse("2026-07-31T10:15:00.000Z") + seconds * 1000,
  ).toISOString();

/** The reviewer's verdict: Codex passed the diff *and* filed a blocker. */
const verdict: Verdict = {
  id: `${RUN_ID}-gpt-0`,
  runId: RUN_ID,
  stationId: "gpt",
  harness: "codex",
  vendor: "openai",
  // Recorded as a pass with a blocking finding, which is exactly the case a
  // surface keyed on `decision` would draw green. The Gate held on the
  // finding, not on the word.
  decision: "pass",
  findings: [
    {
      category: "security",
      severity: "block",
      summary:
        "The limiter permanently retains every caller IP, allowing unbounded " +
        "memory growth and eventual denial of service.",
      path: "upload.js",
      line: 14,
    },
  ],
  at: AT(160),
};

export function phase7GateRun(): { run: Run; events: RunEvent[] } {
  const run: Run = {
    id: RUN_ID,
    kind: "prompt",
    status: "held",
    prompt: "Add rate limiting to the upload endpoint in upload.js.",
    stationIds: ["opus", "gpt"],
    workspace: "/Users/noah/code/api",
    createdAt: AT(0),
    startedAt: AT(1),
    finishedAt: AT(171),
    cost: { tokensIn: 41_230, tokensOut: 3_180, usd: 0.5552 },
    error: "Gate “default” held this run: 1 blocking finding (security).",
    result: {
      status: "held",
      cost: { tokensIn: 41_230, tokensOut: 3_180, usd: 0.5552 },
      durationMs: 171_000,
      diff: { filesChanged: 1, insertions: 22, deletions: 1 },
      verdicts: [verdict],
      gates: [
        {
          gate: "default",
          outcome: "hold",
          reasons: [
            "1 blocking finding (security).",
            "0 of 1 required approval (1 review recorded).",
          ],
        },
      ],
      error: "Gate “default” held this run: 1 blocking finding (security).",
    },
  };

  const events: RunEvent[] = [
    { t: "status", at: AT(0), runId: RUN_ID, status: "queued" },
    { t: "status", at: AT(1), runId: RUN_ID, status: "running" },
    // Chunked, because Claude Code streams prose a few words at a time and
    // the coalescing rule is one of the things this fixture is here to test.
    {
      t: "text",
      at: AT(4),
      runId: RUN_ID,
      stationId: "opus",
      chunk: "Reading ",
    },
    {
      t: "text",
      at: AT(4),
      runId: RUN_ID,
      stationId: "opus",
      chunk: "upload.js ",
    },
    {
      t: "text",
      at: AT(5),
      runId: RUN_ID,
      stationId: "opus",
      chunk: "to find the endpoint.",
    },
    {
      t: "tool",
      at: AT(6),
      runId: RUN_ID,
      stationId: "opus",
      name: "Read",
      input: { file_path: "/Users/noah/code/api/upload.js" },
    },
    {
      t: "file",
      at: AT(7),
      runId: RUN_ID,
      stationId: "opus",
      path: "/Users/noah/code/api/upload.js",
      op: "read",
    },
    {
      t: "cost",
      at: AT(20),
      runId: RUN_ID,
      stationId: "opus",
      tokensIn: 18_400,
      tokensOut: 1_900,
      usd: 0.41,
    },
    {
      t: "tool",
      at: AT(52),
      runId: RUN_ID,
      stationId: "opus",
      name: "Edit",
      input: { file_path: "/Users/noah/code/api/upload.js" },
    },
    {
      t: "file",
      at: AT(53),
      runId: RUN_ID,
      stationId: "opus",
      path: "/Users/noah/code/api/upload.js",
      op: "write",
    },
    // The reviewer's prose, from a different Station and a different vendor.
    // It must not be folded into the engineer's paragraph above.
    {
      t: "text",
      at: AT(120),
      runId: RUN_ID,
      stationId: "gpt",
      chunk: "Reviewing the diff.",
    },
    {
      t: "tool",
      at: AT(124),
      runId: RUN_ID,
      stationId: "gpt",
      name: "shell",
      input: { command: "git diff --stat\ngit diff" },
    },
    {
      t: "cost",
      at: AT(158),
      runId: RUN_ID,
      stationId: "gpt",
      tokensIn: 22_830,
      tokensOut: 1_280,
    },
    { t: "verdict", at: AT(160), runId: RUN_ID, stationId: "gpt", verdict },
    {
      t: "standby",
      at: AT(170),
      runId: RUN_ID,
      standbyId: "sb-1",
      ask: "Gate “default” held this run. Release the hold?",
    },
    { t: "status", at: AT(171), runId: RUN_ID, status: "held" },
    {
      t: "done",
      at: AT(171),
      runId: RUN_ID,
      result: run.result as NonNullable<Run["result"]>,
    },
  ];

  return { run, events };
}
