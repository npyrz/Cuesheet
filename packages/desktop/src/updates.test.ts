import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createDesktopUpdates } from "./updates.js";

function setup() {
  const emitter = new EventEmitter();
  const adapter = Object.assign(emitter, {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowPrerelease: true,
    allowDowngrade: true,
    checkForUpdates: vi.fn(async () => ({
      isUpdateAvailable: true,
      updateInfo: { version: "0.1.0-alpha.2" },
    })),
    downloadUpdate: vi.fn(async () => {
      emitter.emit("update-downloaded", { version: "0.1.0-alpha.2" });
      return [];
    }),
    quitAndInstall: vi.fn(),
  });
  const restart = vi.fn();
  const updates = createDesktopUpdates(
    adapter as unknown as Parameters<typeof createDesktopUpdates>[0],
    {
      version: "0.1.0-alpha.1",
      restart,
      changed: vi.fn(),
    },
  );
  return { adapter, updates, restart };
}

describe("desktop updates", () => {
  it("uses only production releases and never installs on ordinary quit", () => {
    const { adapter, updates } = setup();
    expect(adapter.allowPrerelease).toBe(false);
    expect(adapter.allowDowngrade).toBe(false);
    expect(adapter.autoDownload).toBe(false);
    expect(adapter.autoInstallOnAppQuit).toBe(false);
    expect(updates.installRequested()).toBe(false);
  });

  it("coalesces checks and keeps the verified download until restart is requested", async () => {
    const { adapter, updates, restart } = setup();
    const first = updates.check();
    expect(updates.check()).toBe(first);
    await first;
    await updates.check();
    expect(adapter.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(adapter.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(updates.status()).toMatchObject({
      phase: "ready",
      version: "0.1.0-alpha.2",
    });
    expect(restart).not.toHaveBeenCalled();
    expect(adapter.quitAndInstall).not.toHaveBeenCalled();
  });

  it("does not install until the daemon's runs and stores have closed", async () => {
    const { adapter, updates } = setup();
    await updates.check();
    updates.prepareInstall();
    let closed!: () => void;
    const close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          closed = resolve;
        }),
    );
    const install = updates.finishInstall(close);
    expect(updates.finishInstall(close)).toBe(install);
    expect(adapter.quitAndInstall).not.toHaveBeenCalled();
    closed();
    await install;
    expect(close).toHaveBeenCalledTimes(1);
    expect(adapter.quitAndInstall).toHaveBeenCalledExactlyOnceWith(false, true);
  });

  it("refuses installation when shutdown fails or times out", async () => {
    const { adapter, updates } = setup();
    await updates.check();
    updates.prepareInstall();
    await expect(
      updates.finishInstall(() =>
        Promise.reject(new Error("shutdown timeout")),
      ),
    ).rejects.toThrow("shutdown timeout");
    expect(updates.status()).toMatchObject({
      phase: "error",
      message: "shutdown timeout",
    });
    expect(adapter.quitAndInstall).not.toHaveBeenCalled();
  });

  it("reports failed verification and permits retry without making the download installable", async () => {
    const { adapter, updates } = setup();
    adapter.downloadUpdate.mockRejectedValueOnce(
      new Error("Invalid signature"),
    );
    await updates.check();
    expect(updates.status()).toMatchObject({
      phase: "error",
      message: "Invalid signature",
    });
    expect(() => updates.prepareInstall()).toThrow("No verified update");
    await updates.check();
    expect(updates.status().phase).toBe("ready");
  });

  it("contains offline errors and does not download when there is no newer release", async () => {
    const { adapter, updates } = setup();
    adapter.checkForUpdates.mockRejectedValueOnce(new Error("offline"));
    await updates.check();
    expect(updates.status()).toMatchObject({
      phase: "error",
      message: "offline",
    });
    adapter.checkForUpdates.mockResolvedValueOnce({
      isUpdateAvailable: false,
      updateInfo: { version: "0.1.0-alpha.1" },
    });
    await updates.check();
    expect(updates.status().phase).toBe("idle");
    expect(adapter.downloadUpdate).not.toHaveBeenCalled();
  });
});
