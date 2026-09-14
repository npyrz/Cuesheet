/**
 * Reading a verdict out of what a reviewer actually wrote.
 *
 * A reviewer is a language model with a prompt, not an API that returns a
 * struct, so this is a parser over prose — and the only interesting case is
 * the one where it fails. **An unreadable review abstains.** It does not pass.
 * Counting silence, hedging, or a crashed CLI as approval is the difference
 * between a Gate and a decoration, and `evaluateGate` is written so that an
 * abstention cannot satisfy `require`.
 *
 * Two forms are accepted, because asking a model for exactly one and getting
 * it every time is not a thing that happens:
 *
 * 1. A fenced JSON block — `{ "decision": "fail", "findings": [...] }` — which
 *    is what `REVIEW_INSTRUCTIONS` asks for.
 * 2. A bare `VERDICT: fail` line, which is what models write when they
 *    paraphrase the instruction instead of following it.
 */
import type { Finding, VerdictDecision } from "./types.js";

export interface ParsedVerdict {
  decision: VerdictDecision;
  findings: Finding[];
  /** How it was read, for the run log when someone asks why a gate held. */
  source: "json" | "line" | "none";
}

/**
 * What to tell a reviewer. Lives beside the parser on purpose: a prompt and
 * the thing that reads its output are one decision, and splitting them across
 * two packages is how they drift.
 */
export const REVIEW_INSTRUCTIONS = `When you are done, end your reply with a fenced JSON block:

\`\`\`json
{"decision": "pass" | "fail", "findings": [{"category": "security", "severity": "block", "summary": "one line"}]}
\`\`\`

Use "fail" if anything in the diff should not ship. Categories are free-form; use the ones the gate blocks on where they apply. If you cannot review the change, say so and use "abstain".`;

const DECISIONS = new Set<VerdictDecision>(["pass", "fail", "abstain"]);
const SEVERITIES = new Set<Finding["severity"]>(["info", "warn", "block"]);

/** Every fenced block in the text, innermost content only. */
function fencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  const fence = /```[\w-]*\r?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text)) !== null) {
    if (match[1] !== undefined) blocks.push(match[1]);
  }
  return blocks;
}

function asDecision(value: unknown): VerdictDecision | null {
  if (typeof value !== "string") return null;
  const normalised = value.trim().toLowerCase();
  return DECISIONS.has(normalised as VerdictDecision)
    ? (normalised as VerdictDecision)
    : null;
}

function asFindings(value: unknown): Finding[] {
  if (!Array.isArray(value)) return [];
  const findings: Finding[] = [];
  for (const raw of value) {
    if (raw === null || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const category = record["category"];
    const summary = record["summary"];
    if (typeof category !== "string" || category.trim() === "") continue;
    const severity = record["severity"];
    findings.push({
      category: category.trim(),
      // Severity is advisory — a Gate blocks on the *category*, which is what
      // the README's `blocking` list holds — so an unreadable severity
      // defaults to the middle rather than inventing an emergency.
      severity:
        typeof severity === "string" &&
        SEVERITIES.has(severity.trim().toLowerCase() as Finding["severity"])
          ? (severity.trim().toLowerCase() as Finding["severity"])
          : "warn",
      summary:
        typeof summary === "string" && summary.trim() !== ""
          ? summary.trim()
          : `Unexplained ${category.trim()} finding.`,
    });
  }
  return findings;
}

export function parseVerdict(text: string): ParsedVerdict {
  // Last block first: a model that restates the format before using it leaves
  // the example above the real answer.
  for (const block of fencedBlocks(text).reverse()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const record = parsed as Record<string, unknown>;
    const decision = asDecision(record["decision"]);
    if (decision === null) continue;
    return {
      decision,
      findings: asFindings(record["findings"]),
      source: "json",
    };
  }

  // `[\s*]*` rather than an exact shape: what models actually write is
  // `VERDICT: pass`, `**Verdict:** **fail**`, and every combination of bold
  // markers and spacing in between. The word, a colon, and the decision are
  // the only fixed parts.
  const line =
    /(?:^|\n)[\s*]*verdict[\s*]*[:=][\s*]*(pass|fail|abstain)\b/i.exec(text);
  const spoken = asDecision(line?.[1]);
  if (spoken !== null)
    return { decision: spoken, findings: [], source: "line" };

  return { decision: "abstain", findings: [], source: "none" };
}
