import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi, DebugSnapshot, IpcChannelStats } from "../../shared/types.js";
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
});
