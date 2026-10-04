import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionCommands } from "./useSessionCommands.js";
import { PROVIDER_MODELS } from "../../shared/providerModels.js";
import type { ProviderId } from "../../shared/types.js";

describe("useSessionCommands", () => {
  const refreshDashboardStatus = vi.fn().mockResolvedValue(undefined);
  const loadSessionEvents = vi.fn().mockResolvedValue(undefined);
  const setToast = vi.fn();
  const onEarlyStop = vi.fn();
  const terminateMock = vi.fn().mockResolvedValue({ ok: true });
  const archiveMock = vi.fn().mockResolvedValue({ state: "archived" });
  const sendInputMock = vi.fn().mockResolvedValue({ ok: true, queued: false });
  const steerInputMock = vi.fn().mockResolvedValue({ ok: true, queued: false });
  const sendQueuedMessageNowMock = vi.fn().mockResolvedValue({ ok: true, queued: false });

  beforeEach(() => {
    vi.clearAllMocks();
    onEarlyStop.mockReturnValue(undefined);
    terminateMock.mockResolvedValue({ ok: true });
    archiveMock.mockResolvedValue({ state: "archived" });
    sendInputMock.mockResolvedValue({ ok: true, queued: false });
    steerInputMock.mockResolvedValue({ ok: true, queued: false });
    sendQueuedMessageNowMock.mockResolvedValue({ ok: true, queued: false });
    (window as unknown as { argmax: unknown }).argmax = {
      providers: {
        terminate: terminateMock,
        sendInput: sendInputMock,
        steerInput: steerInputMock,
        sendQueuedMessageNow: sendQueuedMessageNowMock
      },
      workspaces: {
        archive: archiveMock
      }
    };
  });

  // Derived from the catalogue so a model gaining or losing the Fast toggle
  // (Composer 2.5 moving to always-Fast) does not need a second edit here.
  const fastModeCases: Array<[ProviderId, string, boolean]> = [
    ...Object.entries(PROVIDER_MODELS).flatMap(([provider, options]) =>
      options.map((option): [ProviderId, string, boolean] => [
        provider as ProviderId,
        option.modelId,
        option.supportsFastMode === true
      ])
    ),
    ["codex", "unknown", false]
  ];

  it.each(fastModeCases)("gates the saved Fast preference for %s/%s", async (provider, modelId, supported) => {
    const { result, rerender } = renderHook(
      ({ fastMode }) => useSessionCommands({ refreshDashboardStatus, loadSessionEvents, setToast, fastMode }),
      { initialProps: { fastMode: false } }
    );
    const model = { provider, label: modelId, modelId };

    await act(async () => {
      await result.current.sendSessionInput("session-1", "continue", model, "auto");
    });
    expect(sendInputMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider, modelId, fastMode: false })
    );

    rerender({ fastMode: true });
    await act(async () => {
      await result.current.sendSessionInput("session-1", "continue", model, "auto");
    });
    expect(sendInputMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider, modelId, fastMode: supported })
    );
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

  it.each(["queue", "steer"] as const)("omits Auto model echoes from a %s send", async (delivery) => {
    const { result } = renderHook(() =>
      useSessionCommands({ refreshDashboardStatus, loadSessionEvents, setToast, fastMode: true })
    );
    await act(async () => {
      await result.current.sendSessionInput("session-1", "continue", {
        provider: "codex", label: "GPT-6 Astra", modelId: "gpt-6-astra",
        reasoningEffort: "high", autoTier: "balanced"
      }, "auto", undefined, undefined, delivery);
    });
    const mock = delivery === "steer" ? steerInputMock : sendInputMock;
    expect(mock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1", input: "continue", fastMode: false })
    );
    for (const field of ["provider", "modelId", "modelLabel", "reasoningEffort"]) {
      expect(mock.mock.calls[0]?.[0]).not.toHaveProperty(field);
    }
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

  it("shows structured queue errors and refreshes after a rejected send", async () => {
    refreshDashboardStatus.mockResolvedValue(undefined);
    loadSessionEvents.mockResolvedValue(undefined);
    sendQueuedMessageNowMock.mockRejectedValueOnce({
      code: "SERVICE_ERROR",
      sub_code: "QUEUED_MESSAGE_ALREADY_DELIVERED",
      message: "This follow-up was already collected from the chat inbox."
    });
    const { result } = renderHook(() =>
      useSessionCommands({ refreshDashboardStatus, loadSessionEvents, setToast, fastMode: false })
    );

    await expect(result.current.sendQueuedMessageNow("session-1", "message-1"))
      .rejects.toThrow("This follow-up was already collected from the chat inbox.");
    expect(refreshDashboardStatus).toHaveBeenCalled();
    expect(loadSessionEvents).toHaveBeenCalledWith("session-1");
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
