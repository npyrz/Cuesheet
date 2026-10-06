import type { PocketStandby } from "@cuesheet/core";

export const POCKET_SESSION = "cuesheet.pocket.session";
export interface PocketSession {
  token: string;
  name: string;
  expiresAt: string;
}

export function pairingToken(fragment: string): string | null {
  const value = new URLSearchParams(fragment.replace(/^#/, "")).get("pair");
  return value !== null && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

export function readPocketSession(
  raw: string | null,
  now = Date.now(),
): PocketSession | null {
  try {
    const value = JSON.parse(raw ?? "null") as Partial<PocketSession> | null;
    return value &&
      typeof value.token === "string" &&
      /^[A-Za-z0-9_-]{43}$/.test(value.token) &&
      typeof value.name === "string" &&
      typeof value.expiresAt === "string" &&
      Date.parse(value.expiresAt) > now
      ? (value as PocketSession)
      : null;
  } catch {
    return null;
  }
}

export function newStandbys(
  previous: readonly string[],
  current: readonly PocketStandby[],
): PocketStandby[] {
  const seen = new Set(previous);
  return current.filter((s) => !seen.has(s.id));
}
