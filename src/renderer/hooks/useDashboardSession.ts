import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type {
  ApprovalRequest,
  DashboardSnapshot,
  ProjectSummary,
  SessionSummary,
  TimelineEvent,
  WorkspaceSummary
} from "../../shared/types.js";
import { SCRATCH_PROJECT_ID } from "../../shared/types.js";
import { errorMessage } from "../../shared/error.js";
import { logger } from "../../shared/logger.js";
import { decodeTimelineEvent } from "../lib/canonicalTimeline.js";
import {
  emptySnapshot,
  mergeDashboardDelta
} from "../lib/snapshot.js";
import { SessionTimelines } from "../lib/sessionTimelines.js";
import { sessionMoveDestination, type SessionMoveDestination } from "../lib/projectMove.js";
import { subscribeRemoteConnection } from "../lib/wsTransport.js";

function isTerminalTimelineEvent(event: TimelineEvent): boolean {
  const decoded = decodeTimelineEvent(event);
  return decoded.kind === "error" || (decoded.kind === "lifecycle" && decoded.name === "completed");
}

/**
 * Drops rows a `dashboard:delta` already advanced past while a status read was
 * in flight — the fetched copy predates the delta, so upserting it would undo
 * the newer state. Rows absent from `current` are new and always kept.
 */
function withoutOutdated<T extends { id: string }>(
  current: T[],
  fetched: T[],
  changedAt: (item: T) => string
): T[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  const kept = fetched.filter((item) => {
    const existing = byId.get(item.id);
    return !existing || changedAt(existing) <= changedAt(item);
  });
  return kept.length === fetched.length ? fetched : kept;
}

/**
 * Re-adds approvals that are still pending locally but missing from a
 * `approvals.pending()` list read before a concurrent delta. The list is
 * authoritative for everything it saw; an approval the backend raised after
 * that read is simply not in it, and dropping it would lose the prompt for
 * good.
 */
function withCarriedPending(current: ApprovalRequest[], fetched: ApprovalRequest[]): ApprovalRequest[] {
  const fetchedIds = new Set(fetched.map((approval) => approval.id));
  const carried = current.filter(
    (approval) => approval.status === "pending" && !fetchedIds.has(approval.id)
  );
  if (carried.length === 0) return fetched;
  // Newest first, the order mergeSlice keeps approvals in.
  return [...fetched, ...carried].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export interface UseDashboardSessionOptions {
  onErrorToast?: (message: string) => void;
}

export interface UseDashboardSessionResult {
  snapshot: DashboardSnapshot;
  timelines: SessionTimelines;
  sessionMoves: ReadonlyMap<string, SessionMoveDestination>;
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
  const [timelines] = useState(() => new SessionTimelines());
  const [sessionMoves, setSessionMoves] = useState<ReadonlyMap<string, SessionMoveDestination>>(() => new Map());
  const rememberSessionMoves = useCallback((events: TimelineEvent[], overwrite = true): void => {
    const moves = events
      .filter((event) => {
        const decoded = decodeTimelineEvent(event);
        return decoded.kind === "lifecycle" && decoded.name === "moved";
      })
      .sort((left, right) => (left.rowCursor ?? 0) - (right.rowCursor ?? 0) || left.createdAt.localeCompare(right.createdAt))
      .map(sessionMoveDestination)
      .filter((move) => move !== null);
    if (moves.length === 0) return;
    setSessionMoves((current) => {
      const next = new Map(current);
      for (const move of moves) {
        const previous = next.get(move.sourceSessionId);
        if (previous && (!overwrite || previous.destinationSessionId === move.destinationSessionId)) continue;
        next.set(move.sourceSessionId, move);
      }
      return next.size === current.size && [...next].every(([id, move]) => current.get(id) === move) ? current : next;
    });
  }, []);
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
  // Sessions a delta pruned while a snapshot load was in flight. `dashboard:list`
  // is a point-in-time DB read, so a prune that lands after that read but before
  // its response reaches us is invisible to it — and the delta merge below is
  // union-by-upsert, which cannot express removal. Null when no load is running.
  const removedDuringLoad = useRef<{ sessions: Set<string>; workspaces: Set<string>; metadata: DashboardSnapshot } | null>(
    null
  );
  const resolveApprovalTokens = useRef(new Map<string, number>());
  const pendingSelectionRef = useRef<{ sessionId: string; workspaceId: string } | null>(null);

  const loadSessionEvents = useCallback(async (sessionId: string): Promise<void> => {
    if (!window.argmax) {
      return;
    }

    let hasMore = true;
    while (hasMore) {
      const ticket = timelines.beginRead(sessionId);
      try {
        const data = await window.argmax.session.eventsSince({
          sessionId,
          eventCursor: ticket.eventCursor,
          rawOutputCursor: ticket.rawOutputCursor,
          changeCursor: ticket.changeCursor
        });
        if (!timelines.finishRead(sessionId, ticket, data)) return;
        rememberSessionMoves(data.events);
        hasMore = data.hasMore === true;
      } finally {
        timelines.cancelRead(sessionId, ticket);
      }
    }
  }, [timelines, rememberSessionMoves]);

  const loadAgentEvents = useCallback(async (sessionId: string, parentToolUseId: string): Promise<void> => {
    if (!window.argmax) {
      return;
    }
    const ticket = timelines.beginRead(sessionId);
    try {
      const data = await window.argmax.session.agentEvents({ sessionId, parentToolUseId });
      timelines.mergeAgentTail(sessionId, data, ticket);
    } finally {
      timelines.cancelRead(sessionId, ticket);
    }
  }, [timelines]);

  const loadDashboard = useCallback(async (propagateError = false): Promise<void> => {
    // A newer authoritative read supersedes an earlier status refresh.
    dashboardRefreshToken.current += 1;
    const token = ++dashboardLoadToken.current;
    const deltaRevision = dashboardDeltaRevision.current;
    const pruned = { sessions: new Set<string>(), workspaces: new Set<string>(), metadata: emptySnapshot };
    removedDuringLoad.current = pruned;
    // A row the sweep deleted mid-load is hard-deleted in SQLite, and nothing
    // removes it later: `loadDashboard` runs once per app run and the merge
    // never deletes. Replay the removals against whatever we settle on.
    const withoutPruned = (settled: DashboardSnapshot): DashboardSnapshot =>
      pruned.sessions.size === 0 && pruned.workspaces.size === 0
        ? settled
        : mergeDashboardDelta(settled, {
            removedSessionIds: [...pruned.sessions],
            removedWorkspaceIds: [...pruned.workspaces]
          });
    try {
      const data = await loadSnapshot();
      if (token !== dashboardLoadToken.current) {
        return;
      }
      rememberSessionMoves(data.events, false);
      // Browser fixtures can include history. Keep newer live rows if a push
      // arrived during the load, and keep transcript data out of React's
      // dashboard state so a token only notifies its own session subscribers.
      const existingEventIds = new Map<string, Set<string>>();
      const existingOutputIds = new Map<string, Set<string>>();
      for (const session of data.sessions) {
        const timeline = timelines.getSnapshot(session.id);
        existingEventIds.set(session.id, new Set(timeline.events.map((event) => event.id)));
        existingOutputIds.set(session.id, new Set(timeline.rawOutputs.map((output) => output.id)));
      }
      timelines.merge(
        data.events.filter((event) => !pruned.sessions.has(event.sessionId) && !existingEventIds.get(event.sessionId)?.has(event.id)),
        data.rawOutputs.filter((output) => !pruned.sessions.has(output.sessionId) && !existingOutputIds.get(output.sessionId)?.has(output.id))
      );
      const metadata = { ...data, events: emptySnapshot.events, rawOutputs: emptySnapshot.rawOutputs };
      setSnapshot(() => {
        if (deltaRevision === dashboardDeltaRevision.current) {
          return withoutPruned(metadata);
        }
        // `dashboard:delta` pushes while loadSnapshot() was in flight. Server
        // lists are authoritative; upsert concurrent entity rows without
        // resurrecting pruned event tails from the pre-load `current` snapshot.
        const merged = mergeDashboardDelta(metadata, {
          sessions: pruned.metadata.sessions,
          workspaces: pruned.metadata.workspaces,
          checks: pruned.metadata.checks,
          projects: pruned.metadata.projects,
          approvals: pruned.metadata.approvals,
          pendingMessages: pruned.metadata.pendingMessages
        });
        return withoutPruned(merged);
      });
      setLoadState("ready");
      setLoadError(null);
    } catch (error) {
      if (token !== dashboardLoadToken.current) {
        return;
      }
      if (!propagateError || snapshotRef.current.projects.length === 0) {
        setLoadState("error");
        setLoadError(errorMessage(error) || "Dashboard load failed");
      }
      if (propagateError) throw error;
    } finally {
      // A newer load may already have claimed the slot; only clear our own.
      if (removedDuringLoad.current === pruned) {
        removedDuringLoad.current = null;
      }
    }
  }, [loadSnapshot, timelines, rememberSessionMoves]);

  const metadataHintsEnabled = useRef(false);
  const metadataRead = useRef<{ dirty: boolean; promise: Promise<void> } | null>(null);
  const loadMetadata = useCallback((): Promise<void> => {
    if (metadataRead.current) {
      metadataRead.current.dirty = true;
      return metadataRead.current.promise;
    }
    const pending = { dirty: false, promise: Promise.resolve() };
    metadataRead.current = pending;
    pending.promise = (async () => {
      try {
        do {
          // State badges do not need token cadence. Fold a burst into one
          // current snapshot while transcript revision reads continue live.
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
          if (recovery.current.disposed) return;
          pending.dirty = false;
          await loadDashboard(true);
        } while (pending.dirty && !recovery.current.disposed);
      } finally {
        metadataRead.current = null;
      }
    })();
    return pending.promise;
  }, [loadDashboard]);

  const hintedReads = useRef(new Map<string, { dirty: boolean; promise: Promise<void> }>());
  const loadHintedSession = useCallback((sessionId: string): Promise<void> => {
    const existing = hintedReads.current.get(sessionId);
    if (existing) {
      existing.dirty = true;
      return existing.promise;
    }
    const pending = { dirty: false, promise: Promise.resolve() };
    hintedReads.current.set(sessionId, pending);
    pending.promise = (async () => {
      try {
        do {
          pending.dirty = false;
          await loadSessionEvents(sessionId);
        } while (pending.dirty && timelines.subscribedSessionIds().includes(sessionId));
      } finally {
        hintedReads.current.delete(sessionId);
      }
    })();
    return pending.promise;
  }, [loadSessionEvents, timelines]);

  const recovery = useRef({ requested: false, running: false, disposed: false });
  const recoveryRetry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recoverDashboard = useCallback(async (): Promise<void> => {
    const state = recovery.current;
    if (state.disposed) return;
    state.requested = true;
    if (state.running) return;
    state.running = true;
    if (recoveryRetry.current !== null) clearTimeout(recoveryRetry.current);
    try {
      do {
        state.requested = false;
        // Keep the last display while replacing its authoritative history.
        // Invalidation also rejects reads started before this recovery pass.
        timelines.invalidate();
        await loadMetadata();
        await Promise.all(timelines.subscribedSessionIds().map(loadHintedSession));
      } while (state.requested && !state.disposed);
    } catch (error) {
      logger.warn("renderer.dashboard", "recovery failed; retrying", { error: errorMessage(error) });
      if (!state.disposed) {
        recoveryRetry.current = setTimeout(() => { void recoverDashboard(); }, 1000);
      }
    } finally {
      state.running = false;
    }
  }, [loadMetadata, loadHintedSession, timelines]);

  useEffect(() => {
    const state = recovery.current;
    state.disposed = false;
    return () => {
      state.disposed = true;
      if (recoveryRetry.current !== null) clearTimeout(recoveryRetry.current);
    };
  }, []);

  useEffect(() => subscribeRemoteConnection((connection) => {
    if (connection.status === "connected" && connection.resync) void recoverDashboard();
  }), [recoverDashboard]);

  const refresh = useCallback(async (): Promise<void> => {
    if (metadataHintsEnabled.current) {
      await loadMetadata().catch((error: unknown) => {
        onErrorToastRef.current?.(errorMessage(error) || "Dashboard refresh failed");
      });
      return;
    }
    const token = ++dashboardRefreshToken.current;
    const deltaRevision = dashboardDeltaRevision.current;
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
        // Both responses were read BEFORE any delta that landed during the
        // await, so on a race they are the stale copy — same guard shape as
        // loadDashboard. Upserting them wholesale would revert a
        // `session.completed` back to running until the next focus, and
        // replacing approvals would erase one the delta had just pushed
        // (approvals only ever arrive as incremental pushes; mergeSlice never
        // re-adds them).
        const raced = deltaRevision !== dashboardDeltaRevision.current;
        const merged = mergeDashboardDelta(current, {
          workspaces: raced
            ? withoutOutdated(current.workspaces, status.workspaces, (workspace) => workspace.lastActivityAt)
            : status.workspaces,
          sessions: raced
            ? withoutOutdated(current.sessions, status.sessions, (session) => session.lastActivityAt)
            : status.sessions,
          checks: raced
            ? withoutOutdated(current.checks, status.checks, (check) => check.completedAt ?? check.startedAt)
            : status.checks
        });
        const authoritative = raced ? withCarriedPending(current.approvals, approvals) : approvals;
        return merged.approvals === authoritative ? merged : { ...merged, approvals: authoritative };
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
      const message = errorMessage(error) || "Dashboard refresh failed";
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
  }, [loadDashboard, loadMetadata]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  useEffect(() => {
    if (!window.argmax) {
      return;
    }
    return window.argmax.dashboard.onDelta((delta) => {
      if (delta.changedSessionIds || delta.dashboardChanged) metadataHintsEnabled.current = true;
      if (delta.resyncRequired) void recoverDashboard();
      dashboardDeltaRevision.current += 1;
      const collecting = removedDuringLoad.current;
      if (collecting) {
        for (const id of delta.removedSessionIds ?? []) collecting.sessions.add(id);
        for (const id of delta.removedWorkspaceIds ?? []) collecting.workspaces.add(id);
      }
      const { events = [], rawOutputs = [], changedSessionIds, dashboardChanged, resyncRequired, ...metadata } = delta;
      if (dashboardChanged && !resyncRequired) {
        void loadMetadata().catch(() => { void recoverDashboard(); });
      }
      if (collecting) collecting.metadata = mergeDashboardDelta(collecting.metadata, metadata);
      rememberSessionMoves(events);
      // New runtimes publish revision hints. Legacy clients and browser
      // fixtures can still deliver rows directly.
      if (!changedSessionIds) timelines.merge(events, rawOutputs);
      const subscribed = new Set(timelines.subscribedSessionIds());
      for (const sessionId of changedSessionIds ?? []) {
        if (!subscribed.has(sessionId)) continue;
        void loadHintedSession(sessionId).catch((error: unknown) => {
          logger.warn("renderer.dashboard", "transcript catch-up failed", { sessionId, error: errorMessage(error) });
          void recoverDashboard();
        });
      }
      const removed = new Set(delta.removedSessionIds ?? []);
      const removedWorkspaces = new Set(delta.removedWorkspaceIds ?? []);
      for (const session of snapshotRef.current.sessions) {
        if (removedWorkspaces.has(session.workspaceId)) removed.add(session.id);
      }
      timelines.remove(removed);
      if (Object.values(metadata).some((value) => Array.isArray(value) ? value.length > 0 : value !== undefined)) {
        setSnapshot((current) => mergeDashboardDelta(current, metadata));
        setLoadState("ready");
        setLoadError(null);
      }
    });
  }, [timelines, rememberSessionMoves, recoverDashboard, loadHintedSession, loadMetadata]);

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

  // History and cursors share a lifetime, including optimistic removals.
  useEffect(() => {
    const ids = new Set(snapshot.sessions.map((session) => session.id));
    timelines.retainSessions(ids);
    setSessionMoves((current) => {
      const retained = [...current].filter(([id]) => ids.has(id));
      return retained.length === current.size ? current : new Map(retained);
    });
  }, [snapshot.sessions, timelines]);

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
      // Never fall back to the hidden "Side chats" scratch project: it is not
      // a repository, so it must not become the launcher's implicit target.
      snapshot.projects.find((project) => project.id !== SCRATCH_PROJECT_ID) ??
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

    setSelectedProjectIdState(
      snapshot.projects.find((project) => project.id !== SCRATCH_PROJECT_ID)?.id ?? null
    );
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
      timelines.getSnapshot(runningSessionId).events
        .filter(
          (event) =>
            event.sessionId === runningSessionId &&
            isTerminalTimelineEvent(event)
        )
        .map((event) => event.id)
    );
    const turnHasTerminalEvent = (): boolean =>
      timelines.getSnapshot(runningSessionId).events.some(
        (event) =>
          event.sessionId === runningSessionId &&
          isTerminalTimelineEvent(event) &&
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
      // Backgrounded windows catch up through the visibility-change refresh
      // below on return; polling IPC + SQLite + re-render four times a second
      // for an invisible window is pure battery drain.
      if (document.hidden) {
        return;
      }
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
  }, [selectedSession?.state, selectedSessionId, selectedWorkspaceId, loadSessionEvents, timelines]);

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
        onErrorToastRef.current?.(errorMessage(error) || "Could not resolve approval.");
      }
    },
    [refresh]
  );

  return {
    snapshot,
    timelines,
    sessionMoves,
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
