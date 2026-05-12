// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { AutoUpdaterLike, DialogLike } from "../updateService.js";
import { UpdateService } from "../updateService.js";

type Listener = (...args: unknown[]) => void;

function buildAutoUpdaterStub(): {
  stub: AutoUpdaterLike;
  emit: (event: string, ...args: unknown[]) => void;
  checkForUpdatesAndNotify: ReturnType<typeof vi.fn>;
  quitAndInstall: ReturnType<typeof vi.fn>;
} {
  const listeners = new Map<string, Listener[]>();
  const checkForUpdatesAndNotify = vi
    .fn<() => Promise<unknown>>()
    .mockResolvedValue({ updateInfo: null });
  const quitAndInstall = vi.fn<() => void>();
  const register = (event: string, listener: Listener): void => {
    const bucket = listeners.get(event) ?? [];
    bucket.push(listener);
    listeners.set(event, bucket);
  };
  const stub: AutoUpdaterLike = {
    checkForUpdatesAndNotify,
    quitAndInstall,
    on: register as unknown as AutoUpdaterLike["on"]
  };
  return {
    stub,
    checkForUpdatesAndNotify,
    quitAndInstall,
    emit: (event, ...args) => {
      const bucket = listeners.get(event) ?? [];
      for (const listener of bucket) listener(...args);
    }
  };
}

function buildDialogStub(response: number): {
  stub: DialogLike;
  showMessageBox: ReturnType<typeof vi.fn>;
} {
  const showMessageBox = vi.fn().mockResolvedValue({ response, checkboxChecked: false });
  const stub: DialogLike = { showMessageBox };
  return { stub, showMessageBox };
}

describe("UpdateService", () => {
  it("invokes checkForUpdatesAndNotify on startup and shows no dialog when no update is available", async () => {
    const updater = buildAutoUpdaterStub();
    const dialog = buildDialogStub(0);
    const service = new UpdateService({ autoUpdater: updater.stub, dialog: dialog.stub });

    await service.runStartupCheck();
    updater.emit("update-not-available");

    expect(updater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("prompts the user with a restart dialog and calls quitAndInstall when they accept", async () => {
    const updater = buildAutoUpdaterStub();
    const dialog = buildDialogStub(0); // 0 = Restart Now
    const service = new UpdateService({ autoUpdater: updater.stub, dialog: dialog.stub });

    await service.runStartupCheck();
    updater.emit("update-downloaded");
    // The restart prompt fires asynchronously via a microtask chain — flush.
    await Promise.resolve();
    await Promise.resolve();

    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    const callArgs = dialog.showMessageBox.mock.calls[0]?.[0] as { buttons?: string[]; message?: string };
    expect(callArgs.buttons).toEqual(["Restart Now", "Later"]);
    expect(callArgs.message).toContain("update");
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("does not call quitAndInstall when the user picks Later", async () => {
    const updater = buildAutoUpdaterStub();
    const dialog = buildDialogStub(1); // 1 = Later
    const service = new UpdateService({ autoUpdater: updater.stub, dialog: dialog.stub });

    await service.runStartupCheck();
    updater.emit("update-downloaded");
    await Promise.resolve();
    await Promise.resolve();

    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("logs but swallows checkForUpdatesAndNotify rejections so startup doesn't crash", async () => {
    const updater = buildAutoUpdaterStub();
    updater.checkForUpdatesAndNotify.mockRejectedValueOnce(new Error("no network"));
    const dialog = buildDialogStub(0);
    const logged: Array<[string, string]> = [];
    const service = new UpdateService({
      autoUpdater: updater.stub,
      dialog: dialog.stub,
      log: (level, message) => {
        logged.push([level, message]);
      }
    });

    await service.runStartupCheck();

    expect(updater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);
    expect(logged.some(([level, message]) => level === "warn" && message.includes("check failed"))).toBe(true);
  });
});
