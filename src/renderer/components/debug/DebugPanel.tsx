import { PanelRightClose } from "lucide-react";
import {
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
  type JSX,
  type MouseEvent as ReactMouseEvent
} from "react";
import type { RawProviderOutput, SessionSummary, TimelineEvent, WorkspaceSummary } from "../../../shared/types.js";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard.js";
import { useDebugSnapshot } from "../../hooks/useDebugSnapshot.js";
import { usePersistedSetting } from "../../hooks/usePersistedSetting.js";
import {
  chatCueLogSnapshot,
  clearChatCueLog,
  subscribeChatCueLog
} from "../../lib/chatCueLog.js";

import { DebugIpcTab } from "./DebugIpcTab.js";
import { DebugLogsTab } from "./DebugLogsTab.js";
import { DebugTraceTab } from "./DebugTraceTab.js";

export const DEBUG_TAB_KEY = "argmax.debugPanel.tab";

const TABS = [
  { id: "trace", label: "Trace" },
  { id: "logs", label: "Logs" },
  { id: "ipc", label: "IPC" }
] as const;

type TabId = (typeof TABS)[number]["id"];

function initialTab(): TabId {
  try {
    const stored = window.localStorage.getItem(DEBUG_TAB_KEY);
    if (TABS.some((tab) => tab.id === stored)) return stored as TabId;
  } catch {
    // Private mode / disabled storage: the default tab is fine.
  }
  return "trace";
}

/**
 * The developer-facing side panel (⌘⇧D).
 *
 * Three live views, deliberately not overlapping with Settings → Advanced,
 * which already renders the static diagnostics report (row counts, startup
 * phases, the full log dump) once per visit:
 *
 * - Trace: this session's normalized events and raw provider output on one
 *   time-ordered list, so a normalizer bug reads as input-next-to-output.
 * - Logs: the backend tracing ring, tailed live and filterable.
 * - IPC: every channel's p50/p99, updating while you use the app.
 *
 * The footer carries the ids you need to leave the app with — to query the
 * SQLite file, or to find the provider CLI's own transcript for this session.
 */
export function DebugPanel({
  events,
  rawOutputs,
  session,
  workspace,
  onClose,
  onResizePanelMouseDown
}: {
  events: TimelineEvent[];
  rawOutputs: RawProviderOutput[];
  session: SessionSummary | null;
  workspace: WorkspaceSummary | null;
  onClose: () => void;
  onResizePanelMouseDown?: (event: ReactMouseEvent) => void;
}): JSX.Element {
  const [tab, setTab] = useState<TabId>(initialTab);
  usePersistedSetting(DEBUG_TAB_KEY, tab);
  // Polling only runs for the tabs that read it; the Trace tab is fed entirely
  // by props that already stream in over `dashboard:delta`.
  const snapshot = useDebugSnapshot(tab === "logs" || tab === "ipc");
  // The chat's own progress-cue breadcrumbs live in the renderer, so they join
  // the backend ring here rather than crossing the IPC boundary twice. Merged
  // by timestamp: both sides stamp ISO-8601 UTC, so the reader sees one
  // chronology and the tab's existing level/scope/text filters cover both.
  const cueLog = useSyncExternalStore(subscribeChatCueLog, chatCueLogSnapshot, chatCueLogSnapshot);
  const logs = useMemo(
    () =>
      cueLog.length === 0
        ? snapshot.logs
        : [...snapshot.logs, ...cueLog].sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    [cueLog, snapshot.logs]
  );
  const clearLogs = useCallback((): void => {
    snapshot.clear();
    clearChatCueLog();
  }, [snapshot]);

  return (
    <aside className="debug-panel" aria-label="Debug panel">
      {onResizePanelMouseDown ? (
        <div className="panel-col-resize-handle" aria-hidden="true" onMouseDown={onResizePanelMouseDown} />
      ) : null}
      <div className="debug-header">
        <div className="debug-tabs" role="tablist" aria-label="Debug views">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={`debug-tab-${entry.id}`}
              aria-controls={`debug-panel-${entry.id}`}
              aria-selected={tab === entry.id}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <button
          className="small-icon"
          type="button"
          title="Close debug panel"
          aria-label="Close debug panel"
          onClick={onClose}
        >
          <PanelRightClose size={18} />
        </button>
      </div>

      {tab === "trace" ? <DebugTraceTab events={events} rawOutputs={rawOutputs} /> : null}
      {tab === "logs" ? (
        <DebugLogsTab logs={logs} error={snapshot.error} onClear={clearLogs} />
      ) : null}
      {tab === "ipc" ? <DebugIpcTab stats={snapshot.ipcStats} error={snapshot.error} /> : null}

      <DebugIdentity session={session} workspace={workspace} />
    </aside>
  );
}

function DebugIdentity({
  session,
  workspace
}: {
  session: SessionSummary | null;
  workspace: WorkspaceSummary | null;
}): JSX.Element | null {
  const [flash, copy] = useCopyToClipboard();
  if (!session && !workspace) return null;

  const ids = [
    session ? `session   ${session.id}` : null,
    session?.providerConversationId ? `provider  ${session.providerConversationId}` : null,
    workspace ? `workspace ${workspace.id}` : null,
    workspace ? `path      ${workspace.path}` : null
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  return (
    <footer className="debug-identity">
      <span className="debug-identity-facts">
        {session ? (
          <>
            <b>{session.provider}</b>
            <span>{session.modelId}</span>
            <span>{session.state}</span>
          </>
        ) : (
          <span>No session</span>
        )}
      </span>
      <button type="button" onClick={() => void copy(ids)} title={ids} aria-label="Copy session and workspace ids">
        {flash === "copied" ? "Copied ids" : flash === "failed" ? "Copy failed" : "Copy ids"}
      </button>
    </footer>
  );
}
