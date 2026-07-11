import { useEffect, useRef, useState, useSyncExternalStore, type JSX } from "react";
import type { IpcChannelStats } from "../../shared/types.js";

export const PERF_OVERLAY_KEY = "argmax.perfOverlay";

const POLL_INTERVAL_MS = 1000;

// Canonical channels surfaced in the dev HUD. Order matters — top to bottom
// in the rendered overlay. Names are the real registered IPC channels; the
// SPEC's draft list used a few stale labels (`workspaces:status`,
// `gitReview:loadDiff`) that don't exist in the registry.
const TRACKED_CHANNELS = [
  "dashboard:list",
  "session:events-since",
  "workspace:status",
  "approvals:pending",
  "review:load-diff"
] as const;

function readEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(PERF_OVERLAY_KEY) === "1";
  } catch {
    return false;
  }
}

function subscribeEnabled(onStoreChange: () => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (event.key === PERF_OVERLAY_KEY || event.key === null) onStoreChange();
  };
  const onFocus = (): void => onStoreChange();
  window.addEventListener("storage", onStorage);
  window.addEventListener("focus", onFocus);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("focus", onFocus);
  };
}

function fmt(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1) return `${(ms * 1000).toFixed(0)}μs`;
  if (ms < 100) return `${ms.toFixed(1)}ms`;
  return `${Math.round(ms)}ms`;
}

export function PerfOverlay(): JSX.Element | null {
  const enabled = useSyncExternalStore(subscribeEnabled, readEnabled, () => false);
  const [stats, setStats] = useState<IpcChannelStats[]>([]);
  const aliveRef = useRef<boolean>(true);

  useEffect(() => {
    if (!enabled) return;
    aliveRef.current = true;
    const tick = async (): Promise<void> => {
      const api = typeof window !== "undefined" ? window.argmax : undefined;
      if (!api?.system?.diagnostics) return;
      try {
        const report = await api.system.diagnostics();
        if (!aliveRef.current) return;
        setStats(report.ipcStats ?? []);
      } catch {
        // Diagnostics IPC is non-essential for the HUD; swallow polling errors.
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      aliveRef.current = false;
      window.clearInterval(id);
    };
  }, [enabled]);

  if (!enabled) return null;

  const byChannel = new Map(stats.map((entry) => [entry.channel, entry]));
  return (
    <div
      role="status"
      aria-label="IPC perf overlay"
      style={{
        position: "fixed",
        right: 12,
        bottom: 12,
        zIndex: 9999,
        background: "var(--ink)",
        color: "var(--bubble-on-ink)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        lineHeight: 1.3,
        padding: "8px 10px",
        borderRadius: 8,
        boxShadow: "var(--shadow-2)",
        pointerEvents: "none",
        minWidth: 220
      }}
    >
      <div style={{ opacity: 0.7, marginBottom: 4, fontSize: "var(--text-2xs)", letterSpacing: 0.4, textTransform: "uppercase" }}>
        IPC p50 / p99
      </div>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <tbody>
          {TRACKED_CHANNELS.map((channel) => {
            const entry = byChannel.get(channel);
            return (
              <tr key={channel} data-channel={channel}>
                <td style={{ paddingRight: 8, opacity: entry ? 1 : 0.5 }}>{channel}</td>
                <td style={{ textAlign: "right", paddingRight: 6, fontVariantNumeric: "tabular-nums" }}>
                  {entry ? fmt(entry.p50) : "—"}
                </td>
                <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", opacity: entry ? 1 : 0.5 }}>
                  {entry ? fmt(entry.p99) : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
