import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi, DiagnosticsReport, IpcChannelStats } from "../../shared/types.js";
import { PERF_OVERLAY_KEY, PerfOverlay } from "./PerfOverlay.js";

const baseDiagnostics: DiagnosticsReport = {
  appVersion: "0.0.0",
  sqliteVersion: "0",
  databasePath: "/tmp/test.db",
  platform: "darwin",
  arch: "arm64",
  generatedAt: "2026-05-14T11:00:00.000Z",
  startupPhases: [],
  databaseStats: {
    rowCounts: {
      projects: 0,
      workspaces: 0,
      sessions: 0,
      events: 0,
      rawOutputs: 0,
      approvals: 0,
      checks: 0,
      checkpoints: 0,
      learnings: 0,
      usageEvents: 0
    },
    walBytes: 0,
    walAutocheckpoint: 1000
  },
  ipcStats: [],
  recentLogs: [],
  sqlitePragmas: {
    journalMode: "wal",
    foreignKeys: 1,
    synchronous: 1,
    busyTimeout: 5000,
    walAutocheckpoint: 1000
  },
  runtime: {
    rssBytes: 0,
    openFileDescriptors: 0,
    tokioTrackedTasks: 0
  }
};

function withIpcStats(stats: IpcChannelStats[]): DiagnosticsReport {
  return { ...baseDiagnostics, ipcStats: stats };
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
    const diagnostics = vi.fn().mockResolvedValue(baseDiagnostics);
    (window as unknown as { argmax: Partial<ArgmaxApi> }).argmax = {
      system: { diagnostics } as unknown as ArgmaxApi["system"]
    };

    render(<PerfOverlay />);

    expect(screen.queryByRole("status", { name: /IPC perf overlay/i })).toBeNull();
    expect(diagnostics).not.toHaveBeenCalled();
  });

  it("renders the tracked channels with p50 / p99 when the flag is set", async () => {
    window.localStorage.setItem(PERF_OVERLAY_KEY, "1");
    const diagnostics = vi.fn().mockResolvedValue(
      withIpcStats([
        { channel: "dashboard:list", count: 12, totalRecorded: 12, p50: 1.2, p99: 4.8 },
        { channel: "session:events-since", count: 30, totalRecorded: 30, p50: 0.8, p99: 3.4 },
        { channel: "providers:launch", count: 1, totalRecorded: 1, p50: 18.5, p99: 32.1 }
      ])
    );
    (window as unknown as { argmax: Partial<ArgmaxApi> }).argmax = {
      system: { diagnostics } as unknown as ArgmaxApi["system"]
    };

    render(<PerfOverlay />);

    const hud = await screen.findByRole("status", { name: /IPC perf overlay/i });
    expect(hud).toBeInTheDocument();

    await waitFor(() => expect(diagnostics).toHaveBeenCalled());

    // Tracked channels render in the SPEC's canonical order.
    const rows = Array.from(hud.querySelectorAll("tr[data-channel]"));
    expect(rows.map((row) => row.getAttribute("data-channel"))).toEqual([
      "dashboard:load",
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
    const load = rows.find((row) => row.getAttribute("data-channel") === "dashboard:load");
    expect(load?.textContent).toContain("—");

    // Non-tracked channel ("providers:launch") is dropped from the HUD.
    expect(hud.textContent).not.toContain("providers:launch");
  });
});
