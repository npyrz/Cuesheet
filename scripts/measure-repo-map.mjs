#!/usr/bin/env node
/**
 * Step 59's live comparison. Build first, then explicitly opt into four short
 * Claude Code runs (these use the logged-in operator's plan):
 *
 *   node scripts/measure-repo-map.mjs --run <new-output-directory>
 *   node scripts/measure-repo-map.mjs --replay <captured-output-directory>
 *
 * Each session gets a fresh copy of the same fixture. Only the production repo
 * map projection differs. Reverse the treatment order for the second task so
 * a warmed vendor cache is not always on the mapped side. "Cold" means a fresh
 * session/workspace, not a claim that the vendor's prompt cache is empty.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run, which } from "../packages/harness/dist/index.js";
import { createRepoMapper } from "../packages/daemon/dist/repomap.js";
import { renderProjection } from "../packages/daemon/dist/projections.js";

const [mode, outputArg] = process.argv.slice(2);
if (
  !["--run", "--replay"].includes(mode) ||
  !outputArg ||
  process.argv.length !== 4
) {
  console.error(
    "usage: node scripts/measure-repo-map.mjs --run|--replay <output-directory>",
  );
  process.exit(2);
}

if (mode === "--replay") {
  const directory = path.resolve(outputArg);
  const recorded = JSON.parse(
    await readFile(path.join(directory, "manifest.json"), "utf8"),
  );
  assert.equal(recorded.runs.length, 4);
  assert.equal(new Set(recorded.runs.map((row) => row.model)).size, 1);
  for (const row of recorded.runs) {
    const events = (
      await readFile(path.join(directory, `${row.id}.jsonl`), "utf8")
    )
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    const measured = measure(events);
    for (const key of Object.keys(measured))
      assert.deepEqual(row[key], measured[key]);
    const final = events.findLast((event) => event.type === "result");
    assert.equal(final.subtype, "success");
    assert.equal(final.is_error, false);
    assert.equal(final.total_cost_usd, row.usd);
    assert.equal(row.testsPassed, true);
    console.log(
      `${row.id}: ${row.callsBeforeFirstEdit} calls before first edit`,
    );
  }
  process.exit(0);
}

const output = path.resolve(outputArg);
// Refuse an existing directory: a later comparison must never overwrite the
// captured evidence of an earlier one. Scratch repositories are kept too.
await mkdir(path.dirname(output), { recursive: true });
await mkdir(output);
const scratch = await mkdtemp(path.join(tmpdir(), "cuesheet-map-measure-"));
const bin = await which("claude");
if (bin === null) throw new Error("Claude Code is not on PATH.");
const version = await checked(bin, ["--version"]);
const revision = await checked("git", ["rev-parse", "HEAD"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
});

const instructions =
  "# Fixture application\n\n" +
  "This is an ESM Node application. Source functions have colocated .test.mjs " +
  "tests. Run `node --test` to verify changes. Keep changes focused. " +
  "Do the task directly without delegating.\n";

const fixture = {
  "package.json": JSON.stringify({ private: true, type: "module" }) + "\n",
  "src/reporting/windows.mjs":
    "export function resolveReportWindow(now, window = 'current') {\n" +
    "  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));\n" +
    "  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));\n" +
    "  if (window === 'previous') {\n" +
    "    return { start: new Date(now.getTime() - 30 * 86400000), end: now };\n" +
    "  }\n" +
    "  return { start, end };\n" +
    "}\n",
  "src/reporting/windows.test.mjs":
    "import { test } from 'node:test';\n" +
    "import assert from 'node:assert/strict';\n" +
    "import { resolveReportWindow } from './windows.mjs';\n" +
    "test('current uses the full UTC calendar month', () => {\n" +
    "  const actual = resolveReportWindow(new Date('2026-03-15T12:00:00Z'));\n" +
    "  assert.equal(actual.start.toISOString(), '2026-03-01T00:00:00.000Z');\n" +
    "  assert.equal(actual.end.toISOString(), '2026-04-01T00:00:00.000Z');\n" +
    "});\n",
  "src/directory/labels.mjs":
    "export function mergeContactLabels(existing, incoming) {\n" +
    "  return [...new Set([...existing, ...incoming])];\n" +
    "}\n",
  "src/directory/labels.test.mjs":
    "import { test } from 'node:test';\n" +
    "import assert from 'node:assert/strict';\n" +
    "import { mergeContactLabels } from './labels.mjs';\n" +
    "test('merges unique labels in insertion order', () => {\n" +
    "  assert.deepEqual(mergeContactLabels(['owner'], ['owner', 'billing']), ['owner', 'billing']);\n" +
    "});\n",
};
// Enough unrelated modules to make discovery real, without a dependency install
// or a repository large enough to turn a four-run measurement into a bill.
for (const [directory, names] of Object.entries({
  billing: ["calculateSubtotal", "applyCredit", "roundCurrency", "invoiceKey"],
  directory: [
    "formatContactName",
    "normalizePhone",
    "contactKey",
    "sortContacts",
  ],
  reporting: ["groupRows", "renderHeading", "sumColumns", "sortReports"],
  pipeline: ["queueKey", "retryDelay", "isTerminal", "batchItems"],
})) {
  for (const name of names) {
    fixture[`src/${directory}/${name}.mjs`] =
      `export function ${name}(value) {\n  return value;\n}\n`;
  }
}

const tasks = [
  {
    id: "calendar-window",
    prompt:
      "Fix resolveReportWindow: the previous window must be the immediately " +
      "preceding full UTC calendar month, including across a year boundary. " +
      "Keep current-window behavior unchanged and add regression tests. " +
      "Verify the tests and report the change briefly.",
    check:
      "const { resolveReportWindow } = await import('./src/reporting/windows.mjs');" +
      "const w = resolveReportWindow(new Date('2026-01-15T12:00:00Z'), 'previous');" +
      "assert.equal(w.start.toISOString(), '2025-12-01T00:00:00.000Z');" +
      "assert.equal(w.end.toISOString(), '2026-01-01T00:00:00.000Z');" +
      "const leap = resolveReportWindow(new Date('2024-03-15T12:00:00Z'), 'previous');" +
      "assert.equal(leap.start.toISOString(), '2024-02-01T00:00:00.000Z');" +
      "assert.equal(leap.end.toISOString(), '2024-03-01T00:00:00.000Z');",
  },
  {
    id: "contact-labels",
    prompt:
      "Fix mergeContactLabels: trim every label, discard blank labels, and " +
      "deduplicate case-insensitively while preserving the first trimmed " +
      "spelling and insertion order. Keep the inputs unchanged and add " +
      "regression tests. Verify the tests and report the change briefly.",
    check:
      "const { mergeContactLabels } = await import('./src/directory/labels.mjs');" +
      "const a = [' Owner ', '', 'BILLING']; const b = ['owner', ' billing ', ' new ', '   '];" +
      "assert.deepEqual(mergeContactLabels(a, b), ['Owner', 'BILLING', 'new']);" +
      "assert.deepEqual(a, [' Owner ', '', 'BILLING']);" +
      "assert.deepEqual(b, ['owner', ' billing ', ' new ', '   ']);" +
      "assert.deepEqual(mergeContactLabels([], [' ', 'x', 'X']), ['x']);",
  },
];

const args = [
  "--print",
  "--verbose",
  "--output-format",
  "stream-json",
  "--permission-mode",
  "acceptEdits",
  "--no-session-persistence",
  "--setting-sources",
  "project",
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
  "--tools",
  "Read,Edit,Write,Glob,Grep,Bash",
  "--allowedTools",
  "Read,Edit,Write,Glob,Grep,Bash(node *)",
  "--max-budget-usd",
  "1",
];

const manifest = {
  schemaVersion: 1,
  measuredAt: new Date().toISOString(),
  revision: revision.trim(),
  platform: process.platform,
  node: process.version,
  cli: version.trim(),
  args,
  fixtureSha256: hash(JSON.stringify(fixture)),
  instructions,
  tasks: tasks.map(({ id, prompt }) => ({ id, prompt })),
  metric:
    "Unique tool invocations before the first successful Edit/Write result; the edit itself is excluded.",
  cold: "New process, new workspace, no resumed session; vendor prompt caches are not controlled.",
  runs: [],
};
await saveManifest();

for (const [taskIndex, task] of tasks.entries()) {
  const order = taskIndex === 0 ? [false, true] : [true, false];
  for (const mapped of order) {
    const id = `${task.id}-${mapped ? "mapped" : "unmapped"}`;
    const cwd = path.join(scratch, id);
    await mkdir(cwd);
    for (const [relative, text] of Object.entries(fixture)) {
      const file = path.join(cwd, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text);
    }
    await checked("git", ["init", "--quiet"], { cwd });
    await writeFile(path.join(cwd, "CLAUDE.md"), instructions);
    await checked(process.execPath, ["--test"], { cwd });
    const mapper = createRepoMapper();
    const map = await mapper.render(cwd, 24_000);
    const repeated = await mapper.render(cwd, 24_000);
    if (map.text !== repeated.text || map.omitted !== 0) {
      throw new Error("The fixture's full map must be byte-stable.");
    }
    if (mapped) {
      await writeFile(
        path.join(cwd, "CLAUDE.md"),
        `${instructions}\n${renderProjection([], map.text)}\n`,
      );
    }
    await writeFile(
      path.join(output, `${id}.context.md`),
      await readFile(path.join(cwd, "CLAUDE.md")),
    );

    console.log(`Starting ${id}`);
    const result = await run(bin, args, {
      cwd,
      stdin: task.prompt,
      timeoutMs: 180_000,
    });
    const events = result.stdout
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
    const captured = events.map(capture).filter((event) => event !== null);
    const serialized = JSON.stringify(captured)
      .replaceAll(JSON.stringify(cwd).slice(1, -1), "{{WORKSPACE}}")
      .replaceAll(cwd.replaceAll("\\", "/"), "{{WORKSPACE}}");
    const scrubbed = JSON.parse(serialized);
    await writeFile(
      path.join(output, `${id}.jsonl`),
      scrubbed.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
    const measurement = measure(scrubbed);
    const final = events.findLast((event) => event.type === "result");
    const row = {
      id,
      mapped,
      mapBytes: mapped ? Buffer.byteLength(map.text) : 0,
      model: events.find((event) => event.subtype === "init")?.model,
      ...measurement,
      exitCode: result.code,
      killed: result.killed,
      result: final?.subtype,
      usd: final?.total_cost_usd,
      testsPassed: false,
    };
    manifest.runs.push(row);
    await saveManifest();
    if (
      result.code !== 0 ||
      result.killed ||
      final?.is_error ||
      final?.subtype !== "success" ||
      measurement.callsBeforeFirstEdit === null
    ) {
      throw new Error(
        `${id} did not finish successfully; inspect its capture.`,
      );
    }
    await checked(process.execPath, ["--test"], { cwd });
    // Independent checks prevent fewer calls made by an incorrect patch from
    // counting as a saving. They run after capture, outside the model session.
    await checked(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import assert from 'node:assert/strict';${task.check}`,
      ],
      { cwd },
    );
    row.testsPassed = true;
    await saveManifest();
    console.log(JSON.stringify(row));
  }
}

console.log(`Evidence: ${output}\nScratch repositories: ${scratch}`);

async function checked(command, argv, options = {}) {
  const result = await run(command, argv, { timeoutMs: 60_000, ...options });
  if (result.code !== 0 || result.killed) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function saveManifest() {
  await writeFile(
    path.join(output, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
}

function hash(text) {
  return createHash("sha256").update(text).digest("hex");
}

function capture(event) {
  // Keep the received tool protocol, but omit account/session identifiers,
  // machine/plugin inventory and narrative text unrelated to the measurement.
  if (event.type === "system" && event.subtype === "init") {
    return {
      type: event.type,
      subtype: event.subtype,
      model: event.model,
      cliVersion: event.claude_code_version,
    };
  }
  if (event.type === "assistant" || event.type === "user") {
    const content = event.message?.content;
    if (!Array.isArray(content)) return null;
    const tools = content.filter(
      (item) => item.type === "tool_use" || item.type === "tool_result",
    );
    return tools.length === 0 ? null : { type: event.type, content: tools };
  }
  if (event.type === "result") {
    return {
      type: event.type,
      subtype: event.subtype,
      is_error: event.is_error,
      total_cost_usd: event.total_cost_usd,
      usage: event.usage,
      num_turns: event.num_turns,
    };
  }
  return null;
}

function measure(events) {
  const calls = [];
  const seen = new Set();
  let firstEdit = null;
  for (const event of events) {
    for (const item of event.content ?? []) {
      if (item.type === "tool_use" && !seen.has(item.id)) {
        seen.add(item.id);
        calls.push({ id: item.id, name: item.name, input: item.input });
      }
      if (item.type === "tool_result" && !item.is_error && firstEdit === null) {
        const index = calls.findIndex((call) => call.id === item.tool_use_id);
        if (index !== -1 && ["Edit", "Write"].includes(calls[index].name)) {
          firstEdit = index;
        }
      }
    }
  }
  return {
    callsBeforeFirstEdit: firstEdit,
    toolsBeforeFirstEdit:
      firstEdit === null
        ? []
        : calls.slice(0, firstEdit).map((call) => call.name),
    firstEdit: firstEdit === null ? null : calls[firstEdit].input.file_path,
    totalToolCalls: calls.length,
  };
}
