// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  remoteInvoke: vi.fn(),
  remoteSubscribe: vi.fn(),
  createWsTransport: vi.fn()
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen
}));

vi.mock("./wsTransport.js", () => ({
  createWsTransport: mocks.createWsTransport
}));

describe("tauriBridge", () => {
  beforeEach(() => {
    delete window.argmax;
    delete window.__TAURI_INTERNALS__;
    mocks.invoke.mockReset();
    mocks.listen.mockReset();
    mocks.remoteInvoke.mockReset();
    mocks.remoteSubscribe.mockReset();
    mocks.createWsTransport.mockReset();
    mocks.createWsTransport.mockReturnValue({
      invoke: mocks.remoteInvoke,
      subscribe: mocks.remoteSubscribe
    });
    window.history.replaceState(null, "", "/");
  });

  it("leaves browser preview without a bridge", async () => {
    const { installTauriBridge } = await import("./tauriBridge.js");

    installTauriBridge();

    expect(window.argmax).toBeUndefined();
  });

  it("installs the stable Argmax renderer API and wraps command inputs for Tauri", async () => {
    window.__TAURI_INTERNALS__ = {};
    mocks.invoke.mockResolvedValue({ ok: true, timestamp: "2026-05-24T00:00:00Z" });
    const { installTauriBridge } = await import("./tauriBridge.js");

    installTauriBridge();
    const result = await window.argmax!.health.ping();

    expect(result).toEqual({ ok: true, timestamp: "2026-05-24T00:00:00Z" });
    expect(mocks.invoke).toHaveBeenCalledWith("health:ping", { input: {} });
  });

  it("adapts positional renderer methods into Rust input objects", async () => {
    window.__TAURI_INTERNALS__ = {};
    mocks.invoke.mockResolvedValue({ ok: true });
    const { installTauriBridge } = await import("./tauriBridge.js");

    installTauriBridge();
    await window.argmax!.providers.terminate("session-1");
    await window.argmax!.review.loadDiff({ kind: "workspace", id: "workspace-1" }, "src-tauri/src.rs");
    await window.argmax!.terminal.terminate("terminal-1");

    expect(mocks.invoke).toHaveBeenCalledWith("providers:terminate", {
      input: { sessionId: "session-1" }
    });
    expect(mocks.invoke).toHaveBeenCalledWith("review:load-diff", {
      input: { kind: "workspace", id: "workspace-1", filePath: "src-tauri/src.rs", comparison: undefined }
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

  it("fans one dashboard:delta subscription out to every listener", async () => {
    // The burst diagnostic counts arrivals; a wrapper per listener made the
    // count depend on how many panes were mounted and warned about a delivery
    // stall that had not happened.
    window.__TAURI_INTERNALS__ = {};
    const unlisten = vi.fn();
    mocks.listen.mockResolvedValue(unlisten);
    const { installTauriBridge } = await import("./tauriBridge.js");

    installTauriBridge();
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = window.argmax!.dashboard.onDelta(first);
    const offSecond = window.argmax!.dashboard.onDelta(second);
    await Promise.resolve();

    expect(mocks.listen).toHaveBeenCalledTimes(1);
    const emit = mocks.listen.mock.calls[0][1] as (event: { payload: unknown }) => void;
    emit({ payload: { sessions: [] } });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    // The transport subscription outlives the first consumer and is dropped
    // only when the last one leaves.
    offFirst();
    expect(unlisten).not.toHaveBeenCalled();
    emit({ payload: { sessions: [] } });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);

    offSecond();
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

  it("installs the remote bridge when the browser asks for it", async () => {
    window.history.replaceState(null, "", "/?remote");
    mocks.remoteInvoke.mockResolvedValue({ ok: true, timestamp: "2026-08-28T00:00:00Z" });
    const { installTauriBridge } = await import("./tauriBridge.js");

    installTauriBridge();
    const result = await window.argmax!.health.ping();

    expect(mocks.createWsTransport).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.remoteInvoke).toHaveBeenCalledWith("health:ping", {});
    expect(result).toEqual({ ok: true, timestamp: "2026-08-28T00:00:00Z" });
    // Remembered so a reload without the query string stays remote.
    expect(window.localStorage.getItem("argmax.remote")).toBe("1");
  });

  it("keeps the remote bridge across reloads once the flag is stored", async () => {
    window.localStorage.setItem("argmax.remote", "1");
    const { installTauriBridge } = await import("./tauriBridge.js");

    installTauriBridge();

    expect(window.argmax).toBeDefined();
    expect(mocks.createWsTransport).toHaveBeenCalledTimes(1);
  });

  it("prefers Tauri IPC over the remote bridge inside the desktop app", async () => {
    window.__TAURI_INTERNALS__ = {};
    window.localStorage.setItem("argmax.remote", "1");
    mocks.invoke.mockResolvedValue({ ok: true, timestamp: "2026-08-28T00:00:00Z" });
    const { installTauriBridge } = await import("./tauriBridge.js");

    installTauriBridge();
    await window.argmax!.health.ping();

    expect(mocks.createWsTransport).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith("health:ping", { input: {} });
  });
});
