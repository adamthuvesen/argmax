import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionCommands } from "./useSessionCommands.js";

describe("useSessionCommands", () => {
  const refreshDashboardStatus = vi.fn().mockResolvedValue(undefined);
  const loadSessionEvents = vi.fn().mockResolvedValue(undefined);
  const setToast = vi.fn();
  const onEarlyStop = vi.fn();
  const terminateMock = vi.fn().mockResolvedValue({ ok: true });

  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as { argmax: unknown }).argmax = {
      providers: {
        terminate: terminateMock
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
  });

  it("skips onEarlyStop when restoreLauncherOnEarlyStop is false", async () => {
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
  });
});
