import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerUpdateRoutes,
  type UpdateService,
  type UpdateStatus,
} from "./updates.js";

const app = () => Fastify();
let server: ReturnType<typeof app>;
afterEach(async () => {
  await server?.close();
});

describe("the update HTTP surface", () => {
  it("reports unsupported standalone installations and refuses controls", async () => {
    server = app();
    registerUpdateRoutes(server);
    expect((await server.inject("/updates")).json().phase).toBe("unavailable");
    expect(
      (await server.inject({ method: "POST", url: "/updates/check" }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/updates/install",
          payload: { confirm: true },
        })
      ).statusCode,
    ).toBe(409);
  });

  it("requires explicit restart confirmation, responds before restart, and rejects duplicates", async () => {
    server = app();
    let phase: UpdateStatus["phase"] = "ready";
    let restarted!: () => void;
    const restart = new Promise<void>((resolve) => {
      restarted = resolve;
    });
    const service: UpdateService = {
      status: () => ({ phase, currentVersion: "0.1.0-alpha.1" }),
      check: vi.fn(async () => {}),
      prepareInstall: () => {
        phase = "installing";
      },
      restart: vi.fn(restarted),
    };
    registerUpdateRoutes(server, service);
    expect(
      (await server.inject({ method: "POST", url: "/updates/install" }))
        .statusCode,
    ).toBe(400);
    expect(service.restart).not.toHaveBeenCalled();
    const response = await server.inject({
      method: "POST",
      url: "/updates/install",
      payload: { confirm: true },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().phase).toBe("installing");
    await restart;
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/updates/install",
          payload: { confirm: true },
        })
      ).statusCode,
    ).toBe(409);
    expect(service.restart).toHaveBeenCalledTimes(1);
  });
});
