import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn()
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen
}));

describe("tauriBridge", () => {
  beforeEach(() => {
    delete window.argmax;
    delete window.__TAURI_INTERNALS__;
    mocks.invoke.mockReset();
    mocks.listen.mockReset();
  });

  it("leaves browser preview without a bridge", async () => {
    const { installTauriBridge } = await import("./tauriBridge.js");

    installTauriBridge();

    expect(window.argmax).toBeUndefined();
  });

  it("installs the legacy Argmax API and wraps command inputs for Tauri", async () => {
    window.__TAURI_INTERNALS__ = {};
    mocks.invoke.mockResolvedValue({ ok: true, timestamp: "2026-05-24T00:00:00Z" });
    const { installTauriBridge } = await import("./tauriBridge.js");

    installTauriBridge();
    const result = await window.argmax!.health.ping();

    expect(result).toEqual({ ok: true, timestamp: "2026-05-24T00:00:00Z" });
    expect(mocks.invoke).toHaveBeenCalledWith("health:ping", { input: {} });
  });

  it("adapts legacy positional methods into Rust input objects", async () => {
    window.__TAURI_INTERNALS__ = {};
    mocks.invoke.mockResolvedValue({ ok: true });
    const { installTauriBridge } = await import("./tauriBridge.js");

    installTauriBridge();
    await window.argmax!.providers.terminate("session-1");
    await window.argmax!.review.loadDiff("workspace-1", "src-tauri/src.rs");
    await window.argmax!.terminal.terminate("terminal-1");

    expect(mocks.invoke).toHaveBeenCalledWith("providers:terminate", {
      input: { sessionId: "session-1" }
    });
    expect(mocks.invoke).toHaveBeenCalledWith("review:load-diff", {
      input: { workspaceId: "workspace-1", filePath: "src-tauri/src.rs" }
    });
    expect(mocks.invoke).toHaveBeenCalledWith("terminal:terminate", {
      input: { terminalId: "terminal-1" }
    });
  });

  it("returns synchronous unsubscribe functions for async Tauri listeners", async () => {
    window.__TAURI_INTERNALS__ = {};
    const unlisten = vi.fn();
    mocks.listen.mockResolvedValue(unlisten);
    const { installTauriBridge } = await import("./tauriBridge.js");

    installTauriBridge();
    const off = window.argmax!.dashboard.onDelta(vi.fn());
    await Promise.resolve();
    off();

    expect(mocks.listen).toHaveBeenCalledWith("dashboard:delta", expect.any(Function));
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("exposes listener registration failures through the ready promise", async () => {
    window.__TAURI_INTERNALS__ = {};
    const error = new Error("event.listen not allowed");
    mocks.listen.mockRejectedValue(error);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { installTauriBridge } = await import("./tauriBridge.js");

    installTauriBridge();
    const off = window.argmax!.terminal.onData(vi.fn());

    await expect(off.ready).rejects.toThrow("event.listen not allowed");
    off();
  });
});
