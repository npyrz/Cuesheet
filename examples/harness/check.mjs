import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exerciseHarness, harnessContractViolations } from "@cuesheet/harness";
import { echoWorker } from "./echo-worker.mjs";

const workspace = await realpath(
  await mkdtemp(path.join(tmpdir(), "cuesheet-harness-")),
);
/** @type {import("@cuesheet/core").Station} */
const station = {
  id: "example",
  harness: echoWorker.id,
  role: "worker",
  workspace,
};
try {
  assert.deepEqual(harnessContractViolations(echoWorker), []);
  const report = await exerciseHarness(echoWorker, {
    station,
    brief: "Hello from the contract.",
  });
  assert.deepEqual(report.violations, []);
  assert.equal(report.result.status, "done");
  assert.deepEqual(report.meterTotal, { tokensIn: 0, tokensOut: 0, usd: 0 });
  assert.ok(
    report.events.some(
      (event) =>
        event.t === "text" && event.chunk === "Hello from the contract.\n",
    ),
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    exerciseHarness(echoWorker, { station, signal: controller.signal }),
    { name: "AbortError" },
  );
  await assert.rejects(
    exerciseHarness(echoWorker, { station: { ...station, role: "engineer" } }),
    /only supports worker/,
  );
  console.log(
    "Harness example passed: contract, output, cost, abort and role refusal.",
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
}
