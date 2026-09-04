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

  beforeEach(() => {
    vi.clearAllMocks();
    onEarlyStop.mockReturnValue(undefined);
    terminateMock.mockResolvedValue({ ok: true });
    archiveMock.mockResolvedValue({ state: "archived" });
    (window as unknown as { argmax: unknown }).argmax = {
      providers: {
        terminate: terminateMock
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
});
