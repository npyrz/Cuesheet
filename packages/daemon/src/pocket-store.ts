import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import nodePath from "node:path";
import { configDir, type HostEnv, type PocketDevice } from "@cuesheet/core";
import { z } from "zod";

export const INVITATION_MS = 2 * 60 * 1000;
export const DEVICE_MS = 24 * 60 * 60 * 1000;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const deviceSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{24}$/),
  name: z.string().min(1).max(80),
  expiresAt: z.iso.datetime(),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
});
const stateSchema = z.object({
  version: z.literal(1),
  origin: z.string().nullable(),
  enabled: z.boolean(),
  devices: z.array(deviceSchema).max(32),
});
type State = z.infer<typeof stateSchema>;

export function pocketOrigin(value: unknown): string {
  if (typeof value !== "string")
    throw new Error("Enter your Tailscale HTTPS URL.");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/i.test(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "Use the HTTPS machine URL from Tailscale Serve, ending in .ts.net, with no path.",
    );
  return url.origin;
}

const digest = (token: string): string =>
  createHash("sha256").update(token).digest("hex");
const same = (token: string, hash: string): boolean =>
  SECRET.test(token) &&
  timingSafeEqual(Buffer.from(digest(token), "hex"), Buffer.from(hash, "hex"));
const secret = (): string => randomBytes(32).toString("base64url");

/** Serialized by the service: a consumed invitation can mint exactly one device. */
export async function openPocketStore(
  env: HostEnv,
  now: () => number = Date.now,
) {
  const file = nodePath.join(configDir(env), "pocket.json");
  let state: State = { version: 1, origin: null, enabled: false, devices: [] };
  try {
    state = stateSchema.parse(JSON.parse(await readFile(file, "utf8")));
    if (state.origin !== null) state.origin = pocketOrigin(state.origin);
    if (state.enabled && !state.origin)
      throw new Error("Enabled Pocket has no HTTPS origin.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let invitation: { hash: string; expires: number } | null = null;

  async function save(next: State): Promise<void> {
    await mkdir(nodePath.dirname(file), { recursive: true });
    const temporary = `${file}.${randomBytes(12).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(next) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, file);
      state = next;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  return {
    enabled: () => state.enabled,
    origin: () => state.origin,
    devices: (): PocketDevice[] =>
      state.devices
        .filter((d) => Date.parse(d.expiresAt) > now())
        .map(({ hash: _hash, ...device }) => device),
    async configure(origin: string | null) {
      await save({ version: 1, enabled: origin !== null, origin, devices: [] });
      invitation = null;
    },
    invite() {
      if (!state.enabled || !state.origin)
        throw new Error("Enable Pocket before pairing a phone.");
      const token = secret();
      const expires = now() + INVITATION_MS;
      invitation = { hash: digest(token), expires };
      // Fragments never reach the proxy's HTTP request or its access logs.
      return {
        url: `${state.origin}/pocket#pair=${token}`,
        expiresAt: new Date(expires).toISOString(),
      };
    },
    cancelInvitation() {
      invitation = null;
    },
    async pair(token: unknown, name: unknown) {
      if (
        !state.enabled ||
        typeof token !== "string" ||
        !invitation ||
        invitation.expires <= now() ||
        !same(token, invitation.hash)
      )
        throw new Error(
          "Pairing link expired or already used. Generate a new QR in the Desk.",
        );
      if (typeof name !== "string" || !name.trim() || name.trim().length > 80)
        throw new Error("Name this phone with 1–80 characters.");
      const devices = state.devices.filter(
        (d) => Date.parse(d.expiresAt) > now(),
      );
      if (devices.length >= 32)
        throw new Error("Revoke a device before pairing another.");
      const credential = secret();
      const device = {
        id: randomBytes(12).toString("hex"),
        name: name.trim(),
        expiresAt: new Date(now() + DEVICE_MS).toISOString(),
        hash: digest(credential),
      };
      await save({ ...state, devices: [...devices, device] });
      invitation = null;
      return {
        token: credential,
        expiresAt: device.expiresAt,
        name: device.name,
      };
    },
    authenticate(token: string): PocketDevice | null {
      if (!state.enabled) return null;
      const device = state.devices.find(
        (d) => Date.parse(d.expiresAt) > now() && same(token, d.hash),
      );
      if (!device) return null;
      const { hash: _hash, ...publicDevice } = device;
      return publicDevice;
    },
    async revoke(id: string) {
      await save({
        ...state,
        devices: state.devices.filter((d) => d.id !== id),
      });
    },
  };
}

export type PocketStore = Awaited<ReturnType<typeof openPocketStore>>;
