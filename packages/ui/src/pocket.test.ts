import { describe, expect, it } from "vitest";
import type { PocketStandby } from "@cuesheet/core";
import { newStandbys, pairingToken, readPocketSession } from "./pocket.js";

describe("Pocket browser state", () => {
  it("reads credentials only from a valid pairing fragment", () => {
    expect(pairingToken(`#pair=${"a".repeat(43)}`)).toBe("a".repeat(43));
    expect(pairingToken("#pair=bad")).toBeNull();
    expect(pairingToken("#token=secret")).toBeNull();
  });
  it("forgets malformed or expired sessions", () => {
    expect(readPocketSession("broken")).toBeNull();
    expect(readPocketSession(null)).toBeNull();
    const session = {
      token: "a".repeat(43),
      name: "Phone",
      expiresAt: "2026-10-06T00:00:00Z",
    };
    expect(
      readPocketSession(
        JSON.stringify(session),
        Date.parse("2026-10-05T00:00:00Z"),
      ),
    ).toEqual(session);
    expect(
      readPocketSession(JSON.stringify(session), Date.parse(session.expiresAt)),
    ).toBeNull();
  });
  it("alerts only for questions arriving since the last successful refresh", () => {
    const standby = (id: string): PocketStandby => ({
      id,
      runId: "run",
      project: "api",
      station: null,
      kind: "hold",
      ask: "Continue?",
      at: "2026-10-05T00:00:00Z",
    });
    expect(newStandbys(["one"], [standby("one"), standby("two")])).toEqual([
      standby("two"),
    ]);
    expect(newStandbys(["one", "two"], [standby("two")])).toEqual([]);
  });
});
