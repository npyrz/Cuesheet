import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("runs the documented first-harness recipe without a vendor or real profile", () => {
  const script = fileURLToPath(
    new URL("../../../examples/harness/check.mjs", import.meta.url),
  );
  const result = execFileSync(process.execPath, [script], {
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result).toContain("Harness example passed");
});
