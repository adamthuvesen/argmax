import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { DashboardSnapshot, ProjectSummary, SessionSummary, WorkspaceSummary } from "../../shared/types.js";
import {
  emptySnapshot,
  mergeByCreatedAt,
  mergeDashboardDelta,
  pruneSupersededDeltas
} from "../lib/snapshot.js";

type SessionCursor = { eventCursor?: number; rawOutputCursor?: number };

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
  // (audit-2026-05-18 M12)
  const dashboardLoadToken = useRef(0);
  const dashboardRefreshToken = useRef(0);
  const dashboardDeltaRevision = useRef(0);
  const sessionCursorsRef = useRef(new Map<string, SessionCursor>());
  const resolveApprovalToken = useRef(0);
  const pendingSelectionRef = useRef<{ sessionId: string; workspaceId: string } | null>(null);

  const loadSessionEvents = useCallback(async (sessionId: string): Promise<void> => {
    if (!window.argmax) {
      return;
    }

    const cursor = sessionCursorsRef.current.get(sessionId);
    // Build the args once instead of two conditional spreads — the spread
    // form allocated a fresh empty object on every undefined branch
    // (ralph E1). Equivalent payload, fewer allocations on the hot path.
    const args: { sessionId: string; eventCursor?: number; rawOutputCursor?: number } = {
      sessionId
    };
    if (cursor?.eventCursor !== undefined) args.eventCursor = cursor.eventCursor;
    if (cursor?.rawOutputCursor !== undefined) args.rawOutputCursor = cursor.rawOutputCursor;
    const data = await window.argmax.session.eventsSince(args);
    sessionCursorsRef.current.set(sessionId, {
      eventCursor: data.eventCursor,
      rawOutputCursor: data.rawOutputCursor
    });
    setSnapshot((current) => ({
      ...current,
      events: pruneSupersededDeltas(mergeByCreatedAt(current.events, data.events, 500, "desc")),
      rawOutputs: mergeByCreatedAt(current.rawOutputs, data.rawOutputs, 100, "desc")
    }));
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
          checkpoints: current.checkpoints,
          projects: current.projects
        });
        return {
          ...merged,
          events: pruneSupersededDeltas(
            mergeByCreatedAt(
              data.events,
              current.events.filter((event) => liveSessionIds.has(event.sessionId)),
              500,
              "desc"
            )
          ),
          rawOutputs: mergeByCreatedAt(
            data.rawOutputs,
            current.rawOutputs.filter((output) => liveSessionIds.has(output.sessionId)),
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
      // Upsert workspaces/sessions/checks/checkpoints via mergeDashboardDelta
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
          checks: status.checks,
          checkpoints: status.checkpoints
        });
        return merged.approvals === approvals ? merged : { ...merged, approvals };
      });
      setLoadState("ready");
      setLoadError(null);
    } catch (error) {
      if (token !== dashboardLoadToken.current) {
        return;
      }
      setLoadState("error");
      setLoadError(error instanceof Error ? error.message : "Dashboard refresh failed");
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

  // Per-session backfill is owned by SessionPane's mount-effect (one call
  // per visible pane). The hook used to also fire loadSessionEvents on
  // every selection change; with the multi-pane grid that doubled the IPC
  // for the focused pane. Removed — the visibility-change effect above
  // still refreshes the currently selected session on tab refocus.

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
      const token = ++resolveApprovalToken.current;
      // Use the ref so the callback's identity doesn't depend on `snapshot`;
      // depending on snapshot would rebuild this callback on every dashboard
      // delta, defeating memoization in every consumer that takes it as a
      // prop.
      const previousSnapshot = snapshotRef.current;

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
        return;
      }

      try {
        await window.argmax.approvals.resolve({ approvalId, status });
        if (token !== resolveApprovalToken.current) {
          return;
        }
        await refresh();
      } catch (error) {
        if (token !== resolveApprovalToken.current) {
          return;
        }
        setSnapshot(previousSnapshot);
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
    openWorkspaceChat,
    openProjectLauncher,
    resolveApproval,
    pendingSelectionRef
  };
}
