import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { DashboardSnapshot, ProjectSummary, SessionSummary, WorkspaceSummary } from "../../shared/types.js";
import { errorMessage } from "../../shared/error.js";
import { logger } from "../../shared/logger.js";
import {
  emptySnapshot,
  mergeByCreatedAt,
  mergeDashboardDelta,
  pruneSupersededDeltas
} from "../lib/snapshot.js";

type SessionCursor = { eventCursor?: number; rawOutputCursor?: number; seeded?: boolean };

export interface UseDashboardSessionOptions {
  onErrorToast?: (message: string) => void;
}

export interface UseDashboardSessionResult {
  snapshot: DashboardSnapshot;
  setSnapshot: Dispatch<SetStateAction<DashboardSnapshot>>;
  loadState: "loading" | "ready" | "error";
  loadError: string | null;
  selectedSessionId: string | null;
  selectedWorkspaceId: string | null;
  selectedProjectId: string | null;
  // Setters are wrapped in useCallback so exhaustive-deps in consumers sees a
  // stable identity across the hook boundary (the raw useState dispatcher is
  // stable too, but ESLint only recognizes that when used in the same body).
  setSelectedSessionId: (value: string | null) => void;
  setSelectedWorkspaceId: (value: string | null) => void;
  setSelectedProjectId: (value: string | null) => void;
  selectedSession: SessionSummary | null;
  selectedWorkspace: WorkspaceSummary | null;
  selectedProject: ProjectSummary | null;
  refresh: () => Promise<void>;
  loadDashboard: () => Promise<void>;
  loadSessionEvents: (sessionId: string) => Promise<void>;
  loadAgentEvents: (sessionId: string, parentToolUseId: string) => Promise<void>;
  openWorkspaceChat: (workspaceId: string) => void;
  openProjectLauncher: (projectId: string) => void;
  resolveApproval: (approvalId: string, status: "approved" | "rejected") => Promise<void>;
  pendingSelectionRef: MutableRefObject<{ sessionId: string; workspaceId: string } | null>;
}

/**
 * Owns the dashboard lifecycle (load → delta merge → visibility refresh) and
 * the selection reconciliation between projects / workspaces / sessions.
 *
 * `loadSnapshot` is the renderer's snapshot-source function. Production wires
 * it to `window.argmax.dashboard.list()`; the browser-preview path injects
 * the static demo snapshot.
 */
export function useDashboardSession(
  loadSnapshot: () => Promise<DashboardSnapshot>,
  options: UseDashboardSessionOptions = {}
): UseDashboardSessionResult {
  const { onErrorToast } = options;
  const onErrorToastRef = useRef(onErrorToast);
  useEffect(() => {
    onErrorToastRef.current = onErrorToast;
  }, [onErrorToast]);

  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(emptySnapshot);
  // Mirror snapshot into a ref so callbacks that need a "current value at
  // call time" reference (e.g. resolveApproval's optimistic-rollback target)
  // don't have to depend on snapshot — which would rebuild their identity on
  // every dashboard delta and defeat downstream memoization.
  const snapshotRef = useRef<DashboardSnapshot>(snapshot);
  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionIdState] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectIdState] = useState<string | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceIdState] = useState<string | null>(null);
  const setSelectedSessionId = useCallback((value: string | null) => setSelectedSessionIdState(value), []);
  const setSelectedProjectId = useCallback((value: string | null) => setSelectedProjectIdState(value), []);
  const setSelectedWorkspaceId = useCallback((value: string | null) => setSelectedWorkspaceIdState(value), []);

  // Independent tokens for full snapshot loads (loadDashboard) and incremental
  // refreshes (refresh). Sharing a token caused `refresh` to cancel a
  // concurrent `loadDashboard` (and vice versa) — including `refresh`'s own
  // re-entrant call into `loadDashboard` when `window.argmax` is missing.
  const dashboardLoadToken = useRef(0);
  const dashboardRefreshToken = useRef(0);
  const dashboardDeltaRevision = useRef(0);
  const sessionCursorsRef = useRef(new Map<string, SessionCursor>());
  const resolveApprovalTokens = useRef(new Map<string, number>());
  const pendingSelectionRef = useRef<{ sessionId: string; workspaceId: string } | null>(null);

  const loadSessionEvents = useCallback(async (sessionId: string): Promise<void> => {
    if (!window.argmax) {
      return;
    }

    let cursor = sessionCursorsRef.current.get(sessionId);
    // Self-heal an evicted session. `snapshot.events` is a single array shared
    // by every session and capped to the newest rows across ALL of them (the
    // mergeByCreatedAt(…, 500) below plus mergeEventsBounded on the delta
    // path). A busy session can therefore evict an idle session's rows from the
    // array while that idle session's cursor stays parked at the last fetched
    // rowid. A cursored `eventsSince` then returns only rows NEWER than the
    // cursor — none, for an idle session — so the conversation re-renders empty
    // (often just the user message that happened to survive the cap) and never
    // recovers. If this session is seeded but the snapshot now holds none of
    // its events, the rows were evicted: drop the
    // cursor and re-pull the tail from scratch. The `seeded` guard keeps a
    // genuinely event-less session from looping on full re-reads.
    if (
      cursor?.seeded &&
      cursor.eventCursor &&
      !snapshotRef.current.events.some((event) => event.sessionId === sessionId)
    ) {
      sessionCursorsRef.current.delete(sessionId);
      cursor = undefined;
    }
    // Build the args once instead of two conditional spreads — the spread
    // form allocated a fresh empty object on every undefined branch
    // (ralph E1). Equivalent payload, fewer allocations on the hot path.
    const args = {
      sessionId,
      eventCursor: cursor?.eventCursor ?? null,
      rawOutputCursor: cursor?.rawOutputCursor ?? null
    };
    const data = await window.argmax.session.eventsSince(args);
    const latest = sessionCursorsRef.current.get(sessionId);
    sessionCursorsRef.current.set(sessionId, {
      eventCursor: Math.max(latest?.eventCursor ?? 0, data.eventCursor),
      rawOutputCursor: Math.max(latest?.rawOutputCursor ?? 0, data.rawOutputCursor),
      // Once we've seen any events for this session, stay seeded so a later
      // eviction (empty snapshot + parked cursor) is recognised as recoverable.
      seeded: (latest?.seeded ?? false) || data.events.length > 0
    });
    setSnapshot((current) =>
      mergeDashboardDelta(current, {
        events: data.events,
        rawOutputs: data.rawOutputs
      })
    );
  }, []);

  const loadAgentEvents = useCallback(async (sessionId: string, parentToolUseId: string): Promise<void> => {
    if (!window.argmax) {
      return;
    }
    const data = await window.argmax.session.agentEvents({ sessionId, parentToolUseId });
    setSnapshot((current) =>
      mergeDashboardDelta(current, {
        events: data.events,
        rawOutputs: data.rawOutputs
      })
    );
  }, []);

  const loadDashboard = useCallback(async (): Promise<void> => {
    const token = ++dashboardLoadToken.current;
    const deltaRevision = dashboardDeltaRevision.current;
    try {
      const data = await loadSnapshot();
      if (token !== dashboardLoadToken.current) {
        return;
      }
      setSnapshot((current) => {
        if (deltaRevision === dashboardDeltaRevision.current) {
          return data;
        }
        // `dashboard:delta` pushes while loadSnapshot() was in flight. Server
        // lists are authoritative; upsert concurrent entity rows without
        // resurrecting pruned event tails from the pre-load `current` snapshot.
        const liveSessionIds = new Set(data.sessions.map((session) => session.id));
        const merged = mergeDashboardDelta(data, {
          sessions: current.sessions,
          workspaces: current.workspaces,
          checks: current.checks,
          projects: current.projects
        });
        return {
          ...merged,
          events: pruneSupersededDeltas(
            mergeByCreatedAt(
              current.events.filter((event) => liveSessionIds.has(event.sessionId)),
              data.events,
              500,
              "desc"
            )
          ),
          rawOutputs: mergeByCreatedAt(
            current.rawOutputs.filter((output) => liveSessionIds.has(output.sessionId)),
            data.rawOutputs,
            100,
            "desc"
          )
        };
      });
      setLoadState("ready");
      setLoadError(null);
    } catch (error) {
      if (token !== dashboardLoadToken.current) {
        return;
      }
      setLoadState("error");
      setLoadError(error instanceof Error ? error.message : "Dashboard load failed");
    }
  }, [loadSnapshot]);

  const refresh = useCallback(async (): Promise<void> => {
    const token = ++dashboardRefreshToken.current;
    try {
      if (!window.argmax) {
        await loadDashboard();
        return;
      }

      const [status, approvals] = await Promise.all([
        window.argmax.workspaces.status(),
        window.argmax.approvals.pending()
      ]);
      if (token !== dashboardRefreshToken.current) {
        return;
      }
      // Upsert workspaces/sessions/checks via mergeDashboardDelta
      // instead of spreading them on top. Spreading races with concurrent
      // dashboard deltas: if a delta arrived during the await with a
      // newly-launched session, the status response (captured before the
      // delta) wouldn't include it, and the spread would erase the session
      // from the snapshot — making the grid reconcile drop its cell and the
      // chat unmount-remount. Upsert semantics keep additions that arrived
      // mid-refresh.
      //
      // Approvals stay a full replacement: the pending list IS the current
      // truth, and merging would leave resolved approvals lingering in
      // snapshot.approvals because mergeSlice never deletes.
      setSnapshot((current) => {
        const merged = mergeDashboardDelta(current, {
          workspaces: status.workspaces,
          sessions: status.sessions,
          checks: status.checks
        });
        return merged.approvals === approvals ? merged : { ...merged, approvals };
      });
      setLoadState("ready");
      setLoadError(null);
    } catch (error) {
      if (token !== dashboardRefreshToken.current) {
        return;
      }
      // A single failed incremental refresh must not blank a dashboard that
      // already has content: App renders loadState === "error" as a
      // full-screen EmptyState, so escalating here would throw away the
      // last-good snapshot on any transient blip (backend busy, IPC hiccup).
      // Only fall into the fatal error state when there is nothing populated
      // to preserve (the initial loadDashboard path owns that case). Otherwise
      // keep the snapshot, log a breadcrumb, and surface a toast.
      const current = snapshotRef.current;
      const hasSnapshot =
        current.projects.length > 0 || current.workspaces.length > 0 || current.sessions.length > 0;
      const message = error instanceof Error ? error.message : "Dashboard refresh failed";
      if (hasSnapshot) {
        logger.warn("renderer.dashboard", "refresh failed; keeping last-good snapshot", {
          error: errorMessage(error)
        });
        onErrorToastRef.current?.(message);
        return;
      }
      setLoadState("error");
      setLoadError(message);
    }
  }, [loadDashboard]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  useEffect(() => {
    if (!window.argmax) {
      return;
    }
    return window.argmax.dashboard.onDelta((delta) => {
      dashboardDeltaRevision.current += 1;
      setSnapshot((current) => mergeDashboardDelta(current, delta));
      setLoadState("ready");
      setLoadError(null);
    });
  }, []);

  useEffect(() => {
    const handleVisibilityChange = (): void => {
      if (document.visibilityState !== "visible") {
        return;
      }
      void refresh();
      if (selectedSessionId) {
        void loadSessionEvents(selectedSessionId);
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [refresh, selectedSessionId, loadSessionEvents]);

  // Drop session-cursor entries for sessions that have left the snapshot
  // (archived workspace, restart) so the Map doesn't grow without bound.
  useEffect(() => {
    const sessionIds = new Set(snapshot.sessions.map((session) => session.id));
    const cursors = sessionCursorsRef.current;
    for (const id of cursors.keys()) {
      if (!sessionIds.has(id)) {
        cursors.delete(id);
      }
    }
  }, [snapshot.sessions]);

  // Reconcile selectedSessionId against the snapshot without clobbering a
  // just-launched session while its dashboard refresh is still in flight.
  useEffect(() => {
    // Clear the pending-launch ref as soon as its target lands in the
    // snapshot, even if focus has moved elsewhere in the multi-pane grid.
    // Otherwise a sidebar click mid-launch leaves the ref orphaned until
    // the next launchTask overwrites it.
    const pending = pendingSelectionRef.current;
    if (pending && snapshot.sessions.some((session) => session.id === pending.sessionId)) {
      pendingSelectionRef.current = null;
    }

    if (!selectedSessionId) {
      return;
    }

    const selectedSession = snapshot.sessions.find((session) => session.id === selectedSessionId);
    if (selectedSession) {
      if (selectedWorkspaceId !== selectedSession.workspaceId) {
        setSelectedWorkspaceIdState(selectedSession.workspaceId);
      }
      return;
    }

    if (pendingSelectionRef.current?.sessionId === selectedSessionId) {
      if (selectedWorkspaceId !== pendingSelectionRef.current.workspaceId) {
        setSelectedWorkspaceIdState(pendingSelectionRef.current.workspaceId);
      }
      return;
    }

    setSelectedSessionIdState(null);
    setSelectedWorkspaceIdState(null);
  }, [snapshot.sessions, selectedSessionId, selectedWorkspaceId]);

  const selectedSession = useMemo(
    () =>
      (selectedSessionId ? snapshot.sessions.find((session) => session.id === selectedSessionId) : null) ??
      (selectedWorkspaceId ? snapshot.sessions.find((session) => session.workspaceId === selectedWorkspaceId) : null) ??
      null,
    [snapshot.sessions, selectedSessionId, selectedWorkspaceId]
  );
  const selectedWorkspace = useMemo(
    () =>
      (selectedSession ? snapshot.workspaces.find((workspace) => workspace.id === selectedSession.workspaceId) : null) ??
      (selectedWorkspaceId ? snapshot.workspaces.find((workspace) => workspace.id === selectedWorkspaceId) : null) ??
      null,
    [snapshot.workspaces, selectedWorkspaceId, selectedSession]
  );
  const selectedProject = useMemo(
    () =>
      (selectedProjectId ? snapshot.projects.find((project) => project.id === selectedProjectId) : null) ??
      snapshot.projects[0] ??
      null,
    [snapshot.projects, selectedProjectId]
  );

  useEffect(() => {
    if (selectedWorkspace) {
      const workspaceProjectId = selectedWorkspace.projectId;
      if (selectedProjectId !== workspaceProjectId) {
        setSelectedProjectIdState(workspaceProjectId);
      }
      return;
    }

    if (selectedProjectId && snapshot.projects.some((project) => project.id === selectedProjectId)) {
      return;
    }

    setSelectedProjectIdState(snapshot.projects[0]?.id ?? null);
  }, [snapshot.projects, selectedProjectId, selectedWorkspace]);

  // Live-streaming safety net (macOS/Tauri). The `dashboard:delta` push is the
  // primary live-update path and is now emitted on the main thread so the
  // event loop delivers it promptly (see docs/runtime.md "Event
  // delivery"). But the macOS event-loop wake-up for background work is
  // historically flaky (tao#625 / winit#219), so as a belt-and-suspenders we
  // poll the selected session on a short interval *while it is actively
  // running*. Pulls go through the IPC invoke path, which stays reliable
  // mid-turn (a push can sit undelivered on an idle loop until something wakes
  // it). This is intentionally scoped to running sessions: idle sessions never
  // poll, so the steady state remains delta-driven (no dashboard-wide poll).
  //
  // Each tick pulls the cheap event tail (`eventsSince`) so streamed text keeps
  // flowing, deduped by `mergeByCreatedAt`. The heavier session/workspace STATE
  // pull (`workspace:status`) runs on two cadences: (1) a throttled mid-turn
  // refresh (~2s) so `changedFiles` and dirty markers track the agent's edits
  // live instead of freezing until the turn ends, and (2) a guaranteed pull
  // when the turn's terminal event (`session.completed`/`error`) lands, to
  // reconcile the `running → complete` push that's most likely to lag and leave
  // the header stuck on "Working". Both IPC calls are synchronous Rust commands
  // sharing one DB mutex with event ingestion, so the status pull is throttled
  // far below the 250ms event tick and an in-flight guard keeps ticks from
  // piling up — doing it every tick (with overlap) once starved a busy turn.
  useEffect(() => {
    if (!window.argmax || selectedSession?.state !== "running" || !selectedSessionId) {
      return;
    }
    const runningSessionId = selectedSessionId;
    const workspaceIds = selectedWorkspaceId ? [selectedWorkspaceId] : null;
    let cancelled = false;
    let inFlight = false;
    let stateReconciled = false;
    // A multi-turn session keeps the `session.completed`/`error` events from
    // EARLIER turns in the snapshot. Without scoping, this turn's reconcile
    // would latch on a prior turn's terminal event the moment the turn starts,
    // fire once while state is still `running`, set `stateReconciled = true`,
    // and then never re-fire for the real end of THIS turn — leaving the header
    // stuck on "Working" (seen with Cursor, whose state transition relies most
    // on this reconcile). Snapshot the terminal-event ids that already exist so
    // only a NEW one — produced by the current turn — counts.
    const priorTerminalEventIds = new Set(
      snapshotRef.current.events
        .filter(
          (event) =>
            event.sessionId === runningSessionId &&
            (event.type === "session.completed" || event.type === "error")
        )
        .map((event) => event.id)
    );
    const turnHasTerminalEvent = (): boolean =>
      snapshotRef.current.events.some(
        (event) =>
          event.sessionId === runningSessionId &&
          (event.type === "session.completed" || event.type === "error") &&
          !priorTerminalEventIds.has(event.id)
      );
    // Throttle for the mid-turn status pull. Edits land on the workspace as the
    // agent works, but `changedFiles` is only refreshed by a `workspace:status`
    // pull — so without this the changed-files card and dirty markers freeze
    // until the turn ends. Pull on a slow cadence (well above the 250ms event
    // tick) so the card tracks edits live without contending the DB mutex.
    const STATUS_REFRESH_MS = 2000;
    // Start the clock at turn focus so the first mid-turn refresh lands one
    // interval out, not on the first tick (avoids a status pull every time a
    // running session is briefly focused).
    let lastStatusPullAt = Date.now();
    const tick = async (): Promise<void> => {
      if (inFlight) {
        return;
      }
      inFlight = true;
      try {
        await loadSessionEvents(runningSessionId);
        if (cancelled || !window.argmax) {
          return;
        }
        // Two reasons to pull workspace status: (a) the turn just ended and the
        // `running → complete` push may have lagged (reconcile once), or (b) a
        // throttled mid-turn refresh so changed-files/dirty state stay live.
        const turnEnded = !stateReconciled && turnHasTerminalEvent();
        const now = Date.now();
        if (!turnEnded && now - lastStatusPullAt < STATUS_REFRESH_MS) {
          return;
        }
        if (turnEnded) {
          stateReconciled = true;
        }
        lastStatusPullAt = now;
        const status = await window.argmax.workspaces.status({ workspaceIds });
        if (cancelled) {
          return;
        }
        setSnapshot((current) =>
          mergeDashboardDelta(current, {
            workspaces: status.workspaces,
            sessions: status.sessions,
            checks: status.checks
          })
        );
      } finally {
        inFlight = false;
      }
    };
    const interval = window.setInterval(() => {
      void tick();
    }, 250);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [selectedSession?.state, selectedSessionId, selectedWorkspaceId, loadSessionEvents]);

  // Per-session backfill is owned by SessionPane's mount-effect (one call per
  // visible pane). The visibility-change effect above refreshes the currently
  // selected session on tab refocus.

  const openWorkspaceChat = useCallback(
    (workspaceId: string): void => {
      const workspace = snapshot.workspaces.find((item) => item.id === workspaceId) ?? null;
      const session = snapshot.sessions.find((item) => item.workspaceId === workspaceId) ?? null;
      setSelectedProjectIdState(workspace?.projectId ?? null);
      setSelectedWorkspaceIdState(workspaceId);
      setSelectedSessionIdState(session?.id ?? null);
    },
    [snapshot.sessions, snapshot.workspaces]
  );

  const openProjectLauncher = useCallback((projectId: string): void => {
    setSelectedProjectIdState(projectId);
    setSelectedSessionIdState(null);
    setSelectedWorkspaceIdState(null);
  }, []);

  const resolveApproval = useCallback(
    async (approvalId: string, status: "approved" | "rejected"): Promise<void> => {
      const token = (resolveApprovalTokens.current.get(approvalId) ?? 0) + 1;
      resolveApprovalTokens.current.set(approvalId, token);
      // Use the ref so the callback's identity doesn't depend on `snapshot`;
      // depending on snapshot would rebuild this callback on every dashboard
      // delta, defeating memoization in every consumer that takes it as a
      // prop.
      const previousApproval = snapshotRef.current.approvals.find((approval) => approval.id === approvalId) ?? null;

      // Optimistic update.
      setSnapshot((current) => ({
        ...current,
        approvals: current.approvals.map((approval) =>
          approval.id === approvalId && approval.status === "pending"
            ? { ...approval, status, resolvedAt: new Date().toISOString() }
            : approval
        )
      }));

      if (!window.argmax) {
        resolveApprovalTokens.current.delete(approvalId);
        return;
      }

      try {
        await window.argmax.approvals.resolve({ approvalId, status });
        if (token !== resolveApprovalTokens.current.get(approvalId)) {
          return;
        }
        resolveApprovalTokens.current.delete(approvalId);
        await refresh();
      } catch (error) {
        if (token !== resolveApprovalTokens.current.get(approvalId)) {
          return;
        }
        resolveApprovalTokens.current.delete(approvalId);
        if (previousApproval) {
          // Roll back only the optimistically-changed fields against the CURRENT
          // row, so a concurrent delta that touched other fields mid-resolution
          // isn't clobbered by the pre-optimistic snapshot.
          setSnapshot((current) => ({
            ...current,
            approvals: current.approvals.map((approval) =>
              approval.id === approvalId
                ? { ...approval, status: previousApproval.status, resolvedAt: previousApproval.resolvedAt }
                : approval
            )
          }));
        }
        onErrorToastRef.current?.(
          error instanceof Error ? error.message : "Could not resolve approval."
        );
      }
    },
    [refresh]
  );

  return {
    snapshot,
    setSnapshot,
    loadState,
    loadError,
    selectedSessionId,
    selectedWorkspaceId,
    selectedProjectId,
    setSelectedSessionId,
    setSelectedWorkspaceId,
    setSelectedProjectId,
    selectedSession,
    selectedWorkspace,
    selectedProject,
    refresh,
    loadDashboard,
    loadSessionEvents,
    loadAgentEvents,
    openWorkspaceChat,
    openProjectLauncher,
    resolveApproval,
    pendingSelectionRef
  };
}
