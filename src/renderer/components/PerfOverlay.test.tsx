import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ArgmaxApi,
  DebugSnapshot,
  IpcChannelStats,
  PerformanceStatus
} from "../../shared/types.js";
import { PERF_OVERLAY_KEY, PerfOverlay } from "./PerfOverlay.js";

function snapshotWith(stats: IpcChannelStats[]): DebugSnapshot {
  return { generatedAt: "2026-05-14T11:00:00.000Z", ipcStats: stats, logs: [] };
}

const previousArgmax = (window as unknown as { argmax?: ArgmaxApi }).argmax;

afterEach(() => {
  window.localStorage.removeItem(PERF_OVERLAY_KEY);
  (window as unknown as { argmax?: ArgmaxApi }).argmax = previousArgmax;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PerfOverlay", () => {
  it("does not mount when the localStorage flag is absent", () => {
    const debugSnapshot = vi.fn().mockResolvedValue(snapshotWith([]));
    (window as unknown as { argmax: Partial<ArgmaxApi> }).argmax = {
      system: { debugSnapshot } as unknown as ArgmaxApi["system"]
    };

    render(<PerfOverlay />);

    expect(screen.queryByRole("status", { name: /IPC perf overlay/i })).toBeNull();
    expect(debugSnapshot).not.toHaveBeenCalled();
  });

  it("renders the tracked channels with p50 / p99 when the flag is set", async () => {
    window.localStorage.setItem(PERF_OVERLAY_KEY, "1");
    const debugSnapshot = vi.fn().mockResolvedValue(
      snapshotWith([
        { channel: "dashboard:list", count: 12, totalRecorded: 12, p50: 1.2, p99: 4.8 },
        { channel: "session:events-since", count: 30, totalRecorded: 30, p50: 0.8, p99: 3.4 },
        { channel: "providers:launch", count: 1, totalRecorded: 1, p50: 18.5, p99: 32.1 }
      ])
    );
    (window as unknown as { argmax: Partial<ArgmaxApi> }).argmax = {
      system: { debugSnapshot } as unknown as ArgmaxApi["system"]
    };

    render(<PerfOverlay />);

    const hud = await screen.findByRole("status", { name: /IPC perf overlay/i });
    expect(hud).toBeInTheDocument();

    await waitFor(() => expect(debugSnapshot).toHaveBeenCalled());

    // Tracked channels render in the SPEC's canonical order.
    const rows = Array.from(hud.querySelectorAll("tr[data-channel]"));
    expect(rows.map((row) => row.getAttribute("data-channel"))).toEqual([
      "dashboard:list",
      "session:events-since",
      "workspace:status",
      "approvals:pending",
      "review:load-diff"
    ]);

    // Sampled channel surfaces its numbers; unsampled tracked channels show "—".
    await waitFor(() => {
      const list = rows.find((row) => row.getAttribute("data-channel") === "dashboard:list");
      expect(list?.textContent).toContain("1.2ms");
      expect(list?.textContent).toContain("4.8ms");
    });
    // Non-tracked channel ("providers:launch") is dropped from the HUD.
    expect(hud.textContent).not.toContain("providers:launch");
  });

  it("starts an owned capture for live metrics and stops it on unmount", async () => {
    window.localStorage.setItem(PERF_OVERLAY_KEY, "1");
    const inactive: PerformanceStatus = {
      recording: false,
      startedAt: null,
      sampleCount: 0,
      droppedSamples: 0,
      latest: null
    };
    const active: PerformanceStatus = {
      recording: true,
      startedAt: "2026-05-14T11:00:00.000Z",
      sampleCount: 1,
      droppedSamples: 0,
      latest: {
        capturedAt: "2026-05-14T11:00:01.000Z",
        elapsedMs: 1_000,
        samplerOverheadMs: 0.4,
        processes: {
          total: { cpuPercent: 12.5, rssBytes: 128 * 1024 * 1024, processCount: 3 },
          host: { cpuPercent: 2.5, rssBytes: 32 * 1024 * 1024, processCount: 1 },
          webview: { cpuPercent: 5, rssBytes: 64 * 1024 * 1024, processCount: 1 },
          agents: { cpuPercent: 5, rssBytes: 32 * 1024 * 1024, processCount: 1 }
        },
        runningChats: 2,
        runningChatsByProvider: { codex: 2 },
        providerEvents: 4,
        providerEventsPerSecond: 4,
        ipcCalls: 2,
        ipcCallsPerSecond: 2,
        pendingProviderItems: 0,
        sqlite: { activeReaders: 0, waitingReads: 0, waitMs: 0 },
        rendererStalls: { count: 1, totalMs: 75, longestMs: 75 }
      }
    };
    const debugSnapshot = vi.fn().mockResolvedValue(snapshotWith([]));
    const performanceStatus = vi.fn()
      .mockResolvedValueOnce(inactive)
      .mockResolvedValue(active);
    const performanceStart = vi.fn().mockResolvedValue(active);
    const performanceStop = vi.fn().mockResolvedValue({});
    (window as unknown as { argmax: Partial<ArgmaxApi> }).argmax = {
      system: {
        debugSnapshot,
        performanceStatus,
        performanceStart,
        performanceStop
      } as unknown as ArgmaxApi["system"]
    };

    const { unmount } = render(<PerfOverlay />);

    const hud = await screen.findByRole("status", { name: /IPC perf overlay/i });
    await waitFor(() => expect(performanceStart).toHaveBeenCalledOnce());
    await waitFor(() => expect(hud.textContent).toContain("12.5%"));
    expect(hud.textContent).toContain("128 MB");
    expect(hud.textContent).toContain("Chats2");
    expect(hud.textContent).toContain("Stalls1");

    unmount();
    await waitFor(() => expect(performanceStop).toHaveBeenCalledOnce());
  });
});
