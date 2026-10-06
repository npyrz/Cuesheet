import { mkdtemp, readFile, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configDir, type HostEnv } from "@cuesheet/core";
import {
  DEVICE_MS,
  INVITATION_MS,
  openPocketStore,
  pocketOrigin,
} from "./pocket-store.js";
import { redactPocket } from "./pocket-redact.js";

let env: HostEnv;
let now: number;
beforeEach(async () => {
  env = {
    platform: process.platform,
    homedir: await mkdtemp(nodePath.join(tmpdir(), "cuesheet-pocket-store-")),
  };
  now = Date.parse("2026-10-05T12:00:00Z");
});
afterEach(async () => {
  await rm(env.homedir, { recursive: true, force: true });
});

describe("pairing credentials", () => {
  it("persists only hashes, and a device survives restart until its expiry", async () => {
    const store = await openPocketStore(env, () => now);
    await store.configure("https://computer.tail123.ts.net");
    const invite = store.invite();
    const token = new URL(invite.url).hash.slice(6);
    const session = await store.pair(token, "Phone");
    const file = nodePath.join(configDir(env), "pocket.json");
    const text = await readFile(file, "utf8");
    expect(text).not.toContain(token);
    expect(text).not.toContain(session.token);
    if (process.platform !== "win32")
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    const reopened = await openPocketStore(env, () => now);
    expect(reopened.authenticate(session.token)?.name).toBe("Phone");
    await expect(store.pair(token, "Another phone")).rejects.toThrow(
      /expired or already used/,
    );
    expect(reopened.authenticate("garbage")).toBeNull();
    now += DEVICE_MS;
    expect(reopened.authenticate(session.token)).toBeNull();
    expect(reopened.devices()).toEqual([]);
  });

  it("expires, replaces and cancels invitations without authorizing a device", async () => {
    const store = await openPocketStore(env, () => now);
    await store.configure("https://computer.tail123.ts.net");
    const first = new URL(store.invite().url).hash.slice(6);
    const second = new URL(store.invite().url).hash.slice(6);
    await expect(store.pair(first, "Phone")).rejects.toThrow();
    now += INVITATION_MS;
    await expect(store.pair(second, "Phone")).rejects.toThrow();
    const third = new URL(store.invite().url).hash.slice(6);
    store.cancelInvitation();
    await expect(store.pair(third, "Phone")).rejects.toThrow();
    expect(store.devices()).toEqual([]);
  });

  it("revokes one phone without affecting another; disabling revokes everything", async () => {
    const store = await openPocketStore(env, () => now);
    await store.configure("https://computer.tail123.ts.net");
    const pair = async () =>
      store.pair(new URL(store.invite().url).hash.slice(6), "Phone");
    const first = await pair();
    const second = await pair();
    const id = store.authenticate(first.token)?.id;
    expect(id).toBeDefined();
    await store.revoke(id ?? "");
    expect(store.authenticate(first.token)).toBeNull();
    expect(store.authenticate(second.token)).not.toBeNull();
    await store.configure(null);
    expect(store.authenticate(second.token)).toBeNull();
    await store.configure("https://computer.tail123.ts.net");
    expect(store.authenticate(second.token)).toBeNull();
  });

  it("refuses corrupt or newer state without overwriting it", async () => {
    const store = await openPocketStore(env);
    await store.configure("https://computer.tail123.ts.net");
    const file = nodePath.join(configDir(env), "pocket.json");
    const text = '{"version":2,"enabled":true}';
    await writeFile(file, text);
    await expect(openPocketStore(env)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(text);
  });
});

describe("the remote text boundary", () => {
  it.each([
    "http://computer.tail123.ts.net",
    "https://example.com",
    "https://user:password@computer.tail123.ts.net",
    "https://computer.tail123.ts.net/path",
    "https://computer.tail123.ts.net?token=x",
    "https://computer.tail123.ts.net#x",
    "https://computer.tail123.ts.net.evil.test",
  ])("refuses %s as a Pocket origin", (origin) =>
    expect(() => pocketOrigin(origin)).toThrow(),
  );

  it("accepts a Tailscale HTTPS origin, including an operator-selected HTTPS port", () => {
    expect(pocketOrigin("https://computer.tail123.ts.net:8443/")).toBe(
      "https://computer.tail123.ts.net:8443",
    );
  });

  it("redacts recognized credentials and bounds text while retaining the question", () => {
    const text = [
      "Proceed? API_TOKEN=supersecret password: 'private password'",
      "Bearer aaa.bbb.ccc https://user:pass@host.example/path",
      "sk-ant-abcdefghijklmnopqrstuvwxyz ghp_abcdefghijklmnopqrstuvwxyz AKIA1234567890123456",
      "-----BEGIN RSA PRIVATE KEY-----\nkey material\n-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const redacted = redactPocket(text);
    expect(redacted).toContain("Proceed?");
    for (const secret of [
      "supersecret",
      "private password",
      "aaa.bbb.ccc",
      "user:pass",
      "abcdefghijklmnopqrstuvwxyz",
      "key material",
      "AKIA1234567890123456",
    ])
      expect(redacted).not.toContain(secret);
    expect(redactPocket("x".repeat(20_000))).toHaveLength(12_000);
    expect(redactPocket('{"apiKey": "hidden"}')).not.toContain("hidden");
    expect(
      redactPocket("-----BEGIN PRIVATE KEY-----\ntruncated-key"),
    ).not.toContain("truncated-key");
  });
});
