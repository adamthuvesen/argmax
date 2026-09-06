import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionCommands } from "./useSessionCommands.js";

describe("useSessionCommands", () => {
  const refreshDashboardStatus = vi.fn().mockResolvedValue(undefined);
  const loadSessionEvents = vi.fn().mockResolvedValue(undefined);
  const setToast = vi.fn();
  const onEarlyStop = vi.fn();
  const terminateMock = vi.fn().mockResolvedValue({ ok: true });
  const archiveMock = vi.fn().mockResolvedValue({ state: "archived" });
  const sendInputMock = vi.fn().mockResolvedValue({ ok: true, queued: false });

  beforeEach(() => {
    vi.clearAllMocks();
    onEarlyStop.mockReturnValue(undefined);
    terminateMock.mockResolvedValue({ ok: true });
    archiveMock.mockResolvedValue({ state: "archived" });
    sendInputMock.mockResolvedValue({ ok: true, queued: false });
    (window as unknown as { argmax: unknown }).argmax = {
      providers: {
        terminate: terminateMock,
        sendInput: sendInputMock
      },
      workspaces: {
        archive: archiveMock
      }
    };
  });

  it("calls onEarlyStop by default on terminateSession", async () => {
    const { result } = renderHook(() =>
      useSessionCommands({
        refreshDashboardStatus,
        loadSessionEvents,
        setToast,
        fastMode: false,
        onEarlyStop
      })
    );

    await act(async () => {
      await result.current.terminateSession("session-1");
    });

    expect(onEarlyStop).toHaveBeenCalledWith("session-1");
    expect(terminateMock).toHaveBeenCalledWith("session-1");
    expect(archiveMock).not.toHaveBeenCalled();
  });

  it("archives the workspace onEarlyStop returns after a successful stop", async () => {
    onEarlyStop.mockReturnValue("workspace-1");
    const { result } = renderHook(() =>
      useSessionCommands({
        refreshDashboardStatus,
        loadSessionEvents,
        setToast,
        fastMode: false,
        onEarlyStop
      })
    );

    await act(async () => {
      await result.current.terminateSession("session-1");
    });

    expect(terminateMock).toHaveBeenCalledWith("session-1");
    expect(archiveMock).toHaveBeenCalledWith({ workspaceId: "workspace-1", force: true });
    expect(terminateMock.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      archiveMock.mock.invocationCallOrder[0] ?? 0
    );
  });

  it("does not archive when terminate fails", async () => {
    onEarlyStop.mockReturnValue("workspace-1");
    terminateMock.mockRejectedValueOnce(new Error("provider gone"));
    const { result } = renderHook(() =>
      useSessionCommands({
        refreshDashboardStatus,
        loadSessionEvents,
        setToast,
        fastMode: false,
        onEarlyStop
      })
    );

    await act(async () => {
      await result.current.terminateSession("session-1");
    });

    expect(archiveMock).not.toHaveBeenCalled();
  });

  it("skips onEarlyStop when restoreLauncherOnEarlyStop is false", async () => {
    onEarlyStop.mockReturnValue("workspace-1");
    const { result } = renderHook(() =>
      useSessionCommands({
        refreshDashboardStatus,
        loadSessionEvents,
        setToast,
        fastMode: false,
        onEarlyStop
      })
    );

    await act(async () => {
      await result.current.terminateSession("session-1", { restoreLauncherOnEarlyStop: false });
    });

    expect(onEarlyStop).not.toHaveBeenCalled();
    expect(terminateMock).toHaveBeenCalledWith("session-1");
    expect(archiveMock).not.toHaveBeenCalled();
  });

  it("resolves sendSessionInput without waiting on dashboard catch-up", async () => {
    let resolveRefresh: (() => void) | undefined;
    refreshDashboardStatus.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        })
    );
    loadSessionEvents.mockImplementation(() => new Promise<void>(() => {}));
    const { result } = renderHook(() =>
      useSessionCommands({
        refreshDashboardStatus,
        loadSessionEvents,
        setToast,
        fastMode: false,
        onEarlyStop
      })
    );

    await act(async () => {
      await result.current.sendSessionInput(
        "session-1",
        "continue",
        { provider: "claude", label: "Opus 5", modelId: "claude-opus-5" },
        "auto"
      );
    });

    expect(sendInputMock).toHaveBeenCalledTimes(1);
    expect(refreshDashboardStatus).toHaveBeenCalled();
    expect(loadSessionEvents).toHaveBeenCalledWith("session-1");
    resolveRefresh?.();
  });

  it("does not wait on dashboard catch-up for a queued follow-up", async () => {
    sendInputMock.mockResolvedValue({ ok: true, queued: true });
    refreshDashboardStatus.mockImplementation(() => new Promise<void>(() => {}));
    const { result } = renderHook(() =>
      useSessionCommands({
        refreshDashboardStatus,
        loadSessionEvents,
        setToast,
        fastMode: false,
        onEarlyStop
      })
    );

    await act(async () => {
      await result.current.sendSessionInput(
        "session-1",
        "queue me",
        { provider: "claude", label: "Opus 5", modelId: "claude-opus-5" },
        "auto"
      );
    });

    expect(refreshDashboardStatus).toHaveBeenCalled();
    expect(loadSessionEvents).not.toHaveBeenCalled();
  });
});
