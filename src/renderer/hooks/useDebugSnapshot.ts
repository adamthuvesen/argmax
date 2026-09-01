import { useCallback, useEffect, useRef, useState } from "react";
import type { BackendLogEntry, IpcChannelStats } from "../../shared/types.js";

const POLL_INTERVAL_MS = 1_000;

/** Renderer-side log ring. The Rust buffer holds 1000; keeping more here lets
 *  a long session's history survive eviction on the main side. */
const LOG_CAP = 4_000;

export interface DebugSnapshotState {
  logs: BackendLogEntry[];
  ipcStats: IpcChannelStats[];
  error: string | null;
  clear: () => void;
}

/**
 * Polls `system:debug-snapshot` while `enabled`, accumulating log lines by
 * their `seq` cursor so each tick transfers only what is new. Deliberately
 * not `system:diagnostics`: that one runs nine `COUNT(*)` scans and shells out
 * to `ps`, which is fine once for a settings page and wrong every second.
 */
export function useDebugSnapshot(enabled: boolean): DebugSnapshotState {
  const [logs, setLogs] = useState<BackendLogEntry[]>([]);
  const [ipcStats, setIpcStats] = useState<IpcChannelStats[]>([]);
  const [error, setError] = useState<string | null>(null);
  const cursor = useRef<number | undefined>(undefined);

  const clear = useCallback(() => {
    cursor.current = undefined;
    setLogs([]);
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;

    const tick = async (): Promise<void> => {
      const api = typeof window === "undefined" ? undefined : window.argmax;
      if (!api?.system?.debugSnapshot) return;
      try {
        const snapshot = await api.system.debugSnapshot({ afterLogSeq: cursor.current });
        if (!alive) return;
        setError(null);
        setIpcStats(snapshot.ipcStats);
        if (snapshot.logs.length > 0) {
          cursor.current = snapshot.logs[snapshot.logs.length - 1]?.seq;
          setLogs((previous) => [...previous, ...snapshot.logs].slice(-LOG_CAP));
        }
      } catch (cause) {
        if (!alive) return;
        setError(cause instanceof Error ? cause.message : "Debug snapshot failed.");
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [enabled]);

  return { logs, ipcStats, error, clear };
}
