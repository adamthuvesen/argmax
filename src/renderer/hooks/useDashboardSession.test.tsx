import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type {
  ApprovalRequest,
  ArgmaxApi,
  DashboardDelta,
  DashboardSnapshot,
  SessionSummary,
  TimelineEvent,
  WorkspaceSummary
} from "../../shared/types.js";
import { emptySnapshot } from "../lib/snapshot.js";
import { useDashboardSession } from "./useDashboardSession.js";

function makeWorkspace(overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    id: "ws-existing",
    projectId: "project-1",
    taskLabel: "Existing",
    branch: "argmax/existing",
    baseRef: "main",
    path: "/tmp/existing",
    state: "running",
    sharedWorkspace: false,
    kind: "git",
    dirty: false,
    changedFiles: 0,
    lastActivityAt: "2026-05-12T15:00:00.000Z",
    pinned: false,
    priorityDismissedAt: null,
    priorityAddedAt: null,
    ...overrides
  };
}

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "session-existing",
    workspaceId: "ws-existing",
    provider: "claude",
    modelLabel: "Haiku 4.5",
    modelId: "claude-haiku-4-5",
    reasoningEffort: undefined,
    permissionMode: "auto-approve",
    providerConversationId: null,
    prompt: "do the thing",
    state: "running",
    attention: "normal",
    startedAt: "2026-05-12T15:00:01.000Z",
    completedAt: null,
    lastActivityAt: "2026-05-12T15:00:01.000Z",
    ...overrides
  };
}

describe("useDashboardSession — refresh / delta race", () => {
  let baseSnapshot: DashboardSnapshot;
  let statusMock: ReturnType<typeof vi.fn<ArgmaxApi["workspaces"]["status"]>>;
  let pendingMock: ReturnType<typeof vi.fn<ArgmaxApi["approvals"]["pending"]>>;
  let resolveApprovalMock: ReturnType<typeof vi.fn<ArgmaxApi["approvals"]["resolve"]>>;
  // The hook subscribes via dashboard.onDelta on mount but the tests below
  // exercise the refresh path directly — they don't dispatch deltas, so the
  // captured listener stays unused. The stub still has to return a noop
  // cleanup so the effect mounts cleanly.

  beforeEach(() => {
    const existingWorkspace = makeWorkspace();
    const existingSession = makeSession();
    baseSnapshot = {
      projects: [
        {
          id: "project-1",
          name: "Argmax",
          repoPath: "/tmp/repo",
          currentBranch: "main",
          defaultBranch: "main",
          settings: {
            worktreeLocation: "/tmp/wt",
            setupCommand: "",
            checkCommands: []
          },
          counts: { active: 1, blocked: 0, failed: 0, reviewReady: 0 },
          latestActivityAt: "2026-05-12T15:00:01.000Z"
        }
      ],
      workspaces: [existingWorkspace],
      sessions: [existingSession],
      events: [],
      rawOutputs: [],
      approvals: [],
      checks: [],
      pendingMessages: {}
    };

    statusMock = vi
      .fn<ArgmaxApi["workspaces"]["status"]>()
      .mockResolvedValue({
        workspaces: baseSnapshot.workspaces,
        sessions: baseSnapshot.sessions,
        checks: baseSnapshot.checks
      });
    pendingMock = vi
      .fn<ArgmaxApi["approvals"]["pending"]>()
      .mockResolvedValue([]);
    resolveApprovalMock = vi
      .fn<ArgmaxApi["approvals"]["resolve"]>()
      .mockResolvedValue({} as Awaited<ReturnType<ArgmaxApi["approvals"]["resolve"]>>);

    (window as unknown as { argmax: ArgmaxApi }).argmax = {
      workspaces: { status: statusMock } as unknown as ArgmaxApi["workspaces"],
      approvals: { pending: pendingMock, resolve: resolveApprovalMock } as unknown as ArgmaxApi["approvals"],
      dashboard: {
        onDelta: () => () => {}
      } as unknown as ArgmaxApi["dashboard"],
      session: {
        eventsSince: vi.fn().mockResolvedValue({
          events: [],
          rawOutputs: [],
          eventCursor: 0,
          rawOutputCursor: 0
        })
      } as unknown as ArgmaxApi["session"]
    } as unknown as ArgmaxApi;
  });

  afterEach(() => {
    cleanup();
    delete (window as { argmax?: unknown }).argmax;
    vi.restoreAllMocks();
  });

  it("does NOT erase sessions/workspaces that aren't in a subsequent status response", async () => {
    // Seed the snapshot directly with two workspaces+sessions. Then have
    // workspaces.status() return only the "stale" subset (just the first
    // entry). Pre-fix, refresh() would replace sessions/workspaces with the
    // stale subset and the second entry vanished — the grid reconcile then
    // dropped its cell and the chat flickered.
    const freshSession = makeSession({
      id: "session-fresh",
      workspaceId: "ws-fresh",
      prompt: "fresh"
    });
    const freshWorkspace = makeWorkspace({ id: "ws-fresh", taskLabel: "Fresh" });
    const seeded: DashboardSnapshot = {
      ...baseSnapshot,
      workspaces: [...baseSnapshot.workspaces, freshWorkspace],
      sessions: [...baseSnapshot.sessions, freshSession]
    };

    // Stable loadSnapshot identity so the auto-rerun loadDashboard effect
    // doesn't keep restoring `seeded` on every render.
    const loadSnapshot = (): Promise<DashboardSnapshot> => Promise.resolve(seeded);
    const { result } = renderHook(() => useDashboardSession(loadSnapshot));
    await waitFor(() => expect(result.current).not.toBeNull());
    await waitFor(() => expect(result.current.loadState).toBe("ready"));
    await waitFor(() => expect(result.current.snapshot.sessions).toHaveLength(2));

    // Backend's status response is stale relative to our snapshot — it only
    // knows about the existing entries, not the fresh one (e.g. status was
    // captured between snapshot load and the delta that added freshWorkspace).
    statusMock.mockResolvedValueOnce({
      workspaces: baseSnapshot.workspaces,
      sessions: baseSnapshot.sessions,
      checks: baseSnapshot.checks
    });

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.snapshot.sessions.map((s) => s.id).sort()).toEqual(
      ["session-existing", "session-fresh"]
    );
    expect(result.current.snapshot.workspaces.map((w) => w.id).sort()).toEqual(
      ["ws-existing", "ws-fresh"]
    );
  });

  it("replaces approvals authoritatively so resolved items don't linger", async () => {
    const pending: ApprovalRequest = {
      id: "approval-1",
      sessionId: "session-existing",
      command: "ls",
      cwd: "/tmp/existing",
      provider: "claude",
      providerInvocationId: null,
      providerRequestId: null,
      riskLevel: "low",
      status: "pending",
      createdAt: "2026-05-12T15:00:02.000Z",
      resolvedAt: null
    };
    baseSnapshot = { ...baseSnapshot, approvals: [pending] };

    statusMock.mockResolvedValue({
      workspaces: baseSnapshot.workspaces,
      sessions: baseSnapshot.sessions,
      checks: baseSnapshot.checks
    });
    // Backend now reports zero pending approvals (e.g. it was resolved).
    pendingMock.mockResolvedValue([]);

    const loadSnapshot = (): Promise<DashboardSnapshot> => Promise.resolve(baseSnapshot);
    const { result } = renderHook(() => useDashboardSession(loadSnapshot));
    await waitFor(() => expect(result.current).not.toBeNull());
    await waitFor(() => expect(result.current.loadState).toBe("ready"));
    await waitFor(() => expect(result.current.snapshot.approvals).toHaveLength(1));

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.snapshot.approvals).toEqual([]);
  });

  it("keeps what a delta wrote while refresh was awaiting its reads", async () => {
    // `workspaces.status()` and `approvals.pending()` are both read BEFORE any
    // delta that lands during the await, so applying them wholesale reverts
    // the delta: a completed session snaps back to running until the next
    // focus, and an approval the delta just pushed is erased for good —
    // approvals only ever arrive as incremental pushes.
    let deltaHandler: ((delta: DashboardDelta) => void) | null = null;
    let resolveStatus!: (value: Awaited<ReturnType<ArgmaxApi["workspaces"]["status"]>>) => void;
    const staleStatus = {
      workspaces: baseSnapshot.workspaces,
      sessions: baseSnapshot.sessions,
      checks: baseSnapshot.checks
    };
    (window as unknown as { argmax: ArgmaxApi }).argmax = {
      workspaces: {
        status: vi.fn(
          () =>
            new Promise<Awaited<ReturnType<ArgmaxApi["workspaces"]["status"]>>>((resolve) => {
              resolveStatus = resolve;
            })
        )
      } as unknown as ArgmaxApi["workspaces"],
      approvals: { pending: pendingMock, resolve: resolveApprovalMock } as unknown as ArgmaxApi["approvals"],
      dashboard: {
        onDelta: (handler: (delta: DashboardDelta) => void) => {
          deltaHandler = handler;
          return () => {
            deltaHandler = null;
          };
        }
      } as unknown as ArgmaxApi["dashboard"],
      session: {
        eventsSince: vi.fn().mockResolvedValue({
          events: [],
          rawOutputs: [],
          eventCursor: 0,
          rawOutputCursor: 0
        })
      } as unknown as ArgmaxApi["session"]
    } as unknown as ArgmaxApi;

    const loadSnapshot = (): Promise<DashboardSnapshot> => Promise.resolve(baseSnapshot);
    const { result } = renderHook(() => useDashboardSession(loadSnapshot));
    await waitFor(() => expect(result.current.loadState).toBe("ready"));
    await waitFor(() => expect(deltaHandler).not.toBeNull());

    const raisedApproval: ApprovalRequest = {
      id: "approval-mid-refresh",
      sessionId: "session-existing",
      command: "rm -rf build",
      cwd: "/tmp/existing",
      provider: "claude",
      providerInvocationId: null,
      providerRequestId: null,
      riskLevel: "high",
      status: "pending",
      createdAt: "2026-05-12T15:00:05.000Z",
      resolvedAt: null
    };

    await act(async () => {
      const pending = result.current.refresh();
      // The turn ends and an approval is raised while the reads are in flight.
      deltaHandler?.({
        sessions: [
          makeSession({ state: "complete", lastActivityAt: "2026-05-12T15:00:06.000Z" })
        ],
        approvals: [raisedApproval]
      });
      resolveStatus(staleStatus);
      await pending;
    });

    expect(result.current.snapshot.sessions[0]?.state).toBe("complete");
    expect(result.current.snapshot.approvals.map((approval) => approval.id)).toEqual([
      "approval-mid-refresh"
    ]);
  });

  it("preserves the last-good snapshot and toasts when a single refresh fails", async () => {
    // A genuine single-refresh failure must NOT blank a populated dashboard:
    // App renders loadState === "error" as a full-screen EmptyState. The
    // failure is surfaced via toast/log instead, and the snapshot is kept.
    // (The token guard only filters superseded refreshes, not real failures.)
    const onErrorToast = vi.fn();
    const loadSnapshot = (): Promise<DashboardSnapshot> => Promise.resolve(baseSnapshot);
    const { result } = renderHook(() => useDashboardSession(loadSnapshot, { onErrorToast }));
    await waitFor(() => expect(result.current.loadState).toBe("ready"));

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.loadState).toBe("ready");

    statusMock.mockRejectedValueOnce(new Error("status refresh failed"));

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.loadState).toBe("ready");
    expect(result.current.snapshot.sessions).toHaveLength(1);
    expect(result.current.snapshot.workspaces).toHaveLength(1);
    expect(onErrorToast).toHaveBeenCalledWith("status refresh failed");
  });

  it("escalates a refresh failure to the error state when no snapshot is populated", async () => {
    // With nothing loaded yet there is no last-good snapshot to protect, so a
    // refresh failure should still surface as the fatal error state.
    const loadSnapshot = (): Promise<DashboardSnapshot> => Promise.resolve(emptySnapshot);
    const { result } = renderHook(() => useDashboardSession(loadSnapshot));
    await waitFor(() => expect(result.current.loadState).toBe("ready"));

    statusMock.mockRejectedValueOnce(new Error("status refresh failed"));

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.loadState).toBe("error");
    expect(result.current.loadError).toBe("status refresh failed");
  });

  it("keeps the reason a Tauri rejection carries instead of a generic fallback", async () => {
    // Tauri command errors arrive as plain values, not Error instances. A
    // migration abort's text is the only actionable thing the user gets, and
    // App renders loadError verbatim in the EmptyState panel.
    const loadSnapshot = (): Promise<DashboardSnapshot> =>
      // Rejecting with a plain object is the behaviour under test: Tauri does exactly this.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      Promise.reject({
        code: "DATABASE_NOT_READY",
        message: "Migration v18 (synced_sessions) checksum drift: stored=abc expected=def"
      });

    const { result } = renderHook(() => useDashboardSession(loadSnapshot));

    await waitFor(() => expect(result.current.loadState).toBe("error"));
    expect(result.current.loadError).toContain("checksum drift");
  });

  it("keeps sessions added by delta during loadSnapshot (audit M11)", async () => {
    const deltaSession = makeSession({
      id: "session-delta",
      workspaceId: "ws-delta",
      prompt: "from delta"
    });
    const deltaWorkspace = makeWorkspace({ id: "ws-delta", taskLabel: "Delta" });

    let deltaHandler: ((delta: DashboardDelta) => void) | null = null;
    (window as unknown as { argmax: ArgmaxApi }).argmax = {
      workspaces: { status: statusMock } as unknown as ArgmaxApi["workspaces"],
      approvals: { pending: pendingMock, resolve: resolveApprovalMock } as unknown as ArgmaxApi["approvals"],
      dashboard: {
        onDelta: (handler: (delta: DashboardDelta) => void) => {
          deltaHandler = handler;
          return () => {
            deltaHandler = null;
          };
        }
      } as unknown as ArgmaxApi["dashboard"],
      session: {
        eventsSince: vi.fn().mockResolvedValue({
          events: [],
          rawOutputs: [],
          eventCursor: 0,
          rawOutputCursor: 0
        })
      } as unknown as ArgmaxApi["session"]
    } as unknown as ArgmaxApi;

    let resolveLoad!: (snapshot: DashboardSnapshot) => void;
    const loadSnapshot = (): Promise<DashboardSnapshot> =>
      new Promise((resolve) => {
        resolveLoad = resolve;
      });

    const { result } = renderHook(() => useDashboardSession(loadSnapshot));
    await waitFor(() => expect(deltaHandler).not.toBeNull());

    act(() => {
      deltaHandler?.({ sessions: [deltaSession], workspaces: [deltaWorkspace] });
    });

    await act(async () => {
      resolveLoad({
        ...baseSnapshot,
        sessions: baseSnapshot.sessions,
        workspaces: baseSnapshot.workspaces
      });
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.loadState).toBe("ready"));
    expect(result.current.snapshot.sessions.map((session) => session.id).sort()).toEqual(
      ["session-delta", "session-existing"]
    );
  });

  it("does not resurrect a session the pruner removed during loadSnapshot", async () => {
    // The sync sweep's first tick fires as the app boots. If its removal delta
    // lands after `dashboard:list` read the DB but before the response arrives,
    // the list still carries the row and the union merge cannot drop it — the
    // row is hard-deleted in SQLite, so the ghost points at nothing forever.
    let deltaHandler: ((delta: DashboardDelta) => void) | null = null;
    (window as unknown as { argmax: ArgmaxApi }).argmax = {
      workspaces: { status: statusMock } as unknown as ArgmaxApi["workspaces"],
      approvals: { pending: pendingMock, resolve: resolveApprovalMock } as unknown as ArgmaxApi["approvals"],
      dashboard: {
        onDelta: (handler: (delta: DashboardDelta) => void) => {
          deltaHandler = handler;
          return () => {
            deltaHandler = null;
          };
        }
      } as unknown as ArgmaxApi["dashboard"],
      session: {
        eventsSince: vi.fn().mockResolvedValue({
          events: [],
          rawOutputs: [],
          eventCursor: 0,
          rawOutputCursor: 0
        })
      } as unknown as ArgmaxApi["session"]
    } as unknown as ArgmaxApi;

    let resolveLoad!: (snapshot: DashboardSnapshot) => void;
    const loadSnapshot = (): Promise<DashboardSnapshot> =>
      new Promise((resolve) => {
        resolveLoad = resolve;
      });

    const { result } = renderHook(() => useDashboardSession(loadSnapshot));
    await waitFor(() => expect(deltaHandler).not.toBeNull());

    act(() => {
      deltaHandler?.({ removedSessionIds: ["session-existing"] });
    });

    await act(async () => {
      // The stale list still carries the pruned session.
      resolveLoad(baseSnapshot);
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.loadState).toBe("ready"));
    expect(result.current.snapshot.sessions).toEqual([]);
  });

  it("reconciles a running→complete transition once the terminal event lands", async () => {
    // macOS push lag: the turn-end `state: running → complete` delta is the
    // last emit and can sit undelivered on an idle event loop, leaving the
    // header stuck on "Working". The poll pulls the cheap event tail every
    // tick; once it sees the turn's terminal event it reconciles session STATE
    // ONCE via workspace:status (the heavy pull stays off the hot path).
    vi.useFakeTimers();
    try {
      const loadSnapshot = (): Promise<DashboardSnapshot> => Promise.resolve(baseSnapshot);
      const { result } = renderHook(() => useDashboardSession(loadSnapshot));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      act(() => {
        result.current.setSelectedWorkspaceId("ws-existing");
        result.current.setSelectedSessionId("session-existing");
      });
      expect(result.current.selectedSession?.state).toBe("running");

      // The event poll pulls the turn's terminal `session.completed`.
      (window.argmax!.session.eventsSince as unknown as Mock<ArgmaxApi["session"]["eventsSince"]>).mockResolvedValueOnce({
        events: [
          {
            id: "ev-done",
            sessionId: "session-existing",
            type: "session.completed",
            message: "",
            payload: {},
            createdAt: "2026-05-12T15:00:30.000Z",
            rowCursor: 10
          }
        ],
        rawOutputs: [],
        eventCursor: 10,
        rawOutputCursor: 0
      });
      // The DB already shows the session complete; status is the only path that
      // flips renderer state.
      statusMock.mockResolvedValue({
        workspaces: [makeWorkspace({ state: "complete" })],
        sessions: [makeSession({ state: "complete", completedAt: "2026-05-12T15:00:30.000Z" })],
        checks: []
      });

      // Tick 1 pulls the terminal event (snapshot ref commits at the act
      // boundary); the next tick detects it and reconciles state once.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });

      expect(statusMock).toHaveBeenCalledWith({ workspaceIds: ["ws-existing"] });
      expect(result.current.selectedSession?.state).toBe("complete");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores terminal events from earlier turns when deciding to reconcile", async () => {
    // A multi-turn session keeps prior turns' `session.completed` events in the
    // snapshot. Keying the reconcile on *any* terminal event latched on a stale
    // one: the reconcile fired once at the start of the next turn (while state
    // was still running), then never again — leaving the header stuck on
    // "Working" for the second turn onward (seen with Cursor).
    vi.useFakeTimers();
    try {
      const seeded: DashboardSnapshot = {
        ...baseSnapshot,
        events: [
          {
            id: "ev-prior-turn",
            sessionId: "session-existing",
            type: "session.completed",
            message: "",
            payload: {},
            createdAt: "2026-05-12T15:00:10.000Z"
          }
        ]
      };
      const loadSnapshot = (): Promise<DashboardSnapshot> => Promise.resolve(seeded);
      const { result } = renderHook(() => useDashboardSession(loadSnapshot));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      act(() => {
        result.current.setSelectedWorkspaceId("ws-existing");
        result.current.setSelectedSessionId("session-existing");
      });
      expect(result.current.selectedSession?.state).toBe("running");
      statusMock.mockClear();

      // Several ticks while THIS turn is still running. The only terminal event
      // in the snapshot belongs to the prior turn, so no reconcile may fire.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(900);
      });
      expect(statusMock).not.toHaveBeenCalled();

      // The current turn ends: a NEW terminal event lands; the DB shows complete.
      (window.argmax!.session.eventsSince as unknown as Mock<ArgmaxApi["session"]["eventsSince"]>).mockResolvedValueOnce({
        events: [
          {
            id: "ev-this-turn",
            sessionId: "session-existing",
            type: "session.completed",
            message: "",
            payload: {},
            createdAt: "2026-05-12T15:00:40.000Z",
            rowCursor: 20
          }
        ],
        rawOutputs: [],
        eventCursor: 20,
        rawOutputCursor: 0
      });
      statusMock.mockResolvedValue({
        workspaces: [makeWorkspace({ state: "complete" })],
        sessions: [makeSession({ state: "complete", completedAt: "2026-05-12T15:00:40.000Z" })],
        checks: []
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });

      expect(statusMock).toHaveBeenCalledWith({ workspaceIds: ["ws-existing"] });
      expect(result.current.selectedSession?.state).toBe("complete");
    } finally {
      vi.useRealTimers();
    }
  });

  it("throttles workspace:status mid-turn instead of pulling it every tick", async () => {
    // Pulling the heavy status command every 250ms tick (and overlapping ticks)
    // starved a busy turn. Mid-turn we still refresh `changedFiles`/dirty state
    // so the UI tracks edits live — but throttled far below the event cadence:
    // nothing within the first interval, then a single pull, not one per tick.
    vi.useFakeTimers();
    try {
      const loadSnapshot = (): Promise<DashboardSnapshot> => Promise.resolve(baseSnapshot);
      const { result } = renderHook(() => useDashboardSession(loadSnapshot));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      act(() => {
        result.current.setSelectedWorkspaceId("ws-existing");
        result.current.setSelectedSessionId("session-existing");
      });
      expect(result.current.selectedSession?.state).toBe("running");
      statusMock.mockClear();

      // Within the first refresh interval: only the cheap event tail runs.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1200);
      });
      expect(statusMock).not.toHaveBeenCalled();
      expect(
        (window.argmax!.session.eventsSince as unknown as Mock<ArgmaxApi["session"]["eventsSince"]>).mock.calls.length
      ).toBeGreaterThan(0);

      // Past the throttle window: exactly one mid-turn status refresh fires,
      // and the still-running session is not flipped to complete by it.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(statusMock).toHaveBeenCalledTimes(1);
      expect(result.current.selectedSession?.state).toBe("running");

      // It stays throttled — a few more ticks don't pull once per tick.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(750);
      });
      expect(statusMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps session event cursors monotonic when overlapping tail reads resolve out of order", async () => {
    let resolveSlow!: (value: Awaited<ReturnType<ArgmaxApi["session"]["eventsSince"]>>) => void;
    let resolveFast!: (value: Awaited<ReturnType<ArgmaxApi["session"]["eventsSince"]>>) => void;
    (window.argmax!.session.eventsSince as unknown as Mock<ArgmaxApi["session"]["eventsSince"]>)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSlow = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFast = resolve;
          })
      )
      .mockResolvedValue({
        events: [],
        rawOutputs: [],
        eventCursor: 0,
        rawOutputCursor: 0
      });

    const loadSnapshot = (): Promise<DashboardSnapshot> => Promise.resolve(baseSnapshot);
    const { result } = renderHook(() => useDashboardSession(loadSnapshot));
    await waitFor(() => expect(result.current.loadState).toBe("ready"));

    let slow!: Promise<void>;
    let fast!: Promise<void>;
    act(() => {
      slow = result.current.loadSessionEvents("session-existing");
      fast = result.current.loadSessionEvents("session-existing");
    });

    await act(async () => {
      resolveFast({ events: [], rawOutputs: [], eventCursor: 20, rawOutputCursor: 10 });
      await fast;
    });
    await act(async () => {
      resolveSlow({ events: [], rawOutputs: [], eventCursor: 5, rawOutputCursor: 4 });
      await slow;
    });

    await act(async () => {
      await result.current.loadSessionEvents("session-existing");
    });

    expect(window.argmax!.session.eventsSince).toHaveBeenLastCalledWith({
      sessionId: "session-existing",
      eventCursor: 20,
      rawOutputCursor: 10
    });
  });

  it("removes synthetic launch rows when cursor-visible tombstones arrive", async () => {
    const syntheticRows: TimelineEvent[] = [
      {
        id: "synthetic-start",
        sessionId: "session-existing",
        type: "command.started",
        message: "spawn_agent",
        payload: { id: "trace-spawn-child", traceSyntheticLaunch: true },
        createdAt: "2026-05-12T15:00:01.000Z",
        rowCursor: 1
      },
      {
        id: "synthetic-end",
        sessionId: "session-existing",
        type: "command.completed",
        message: "spawn_agent",
        payload: { id: "trace-spawn-child", traceSyntheticLaunch: true },
        createdAt: "2026-05-12T15:00:02.000Z",
        rowCursor: 2
      }
    ];
    baseSnapshot = { ...baseSnapshot, events: syntheticRows };
    const tombstoneResponse = {
      events: syntheticRows.map((event, index) => ({
        ...event,
        payload: {
          id: "trace-spawn-child",
          traceSyntheticSuperseded: true,
          traceSupersededBy: "real-spawn"
        },
        rowCursor: 10 + index
      })),
      rawOutputs: [],
      eventCursor: 11,
      rawOutputCursor: 0
    };
    (window.argmax!.session.eventsSince as ReturnType<typeof vi.fn>).mockResolvedValue(
      tombstoneResponse
    );

    const loadSnapshot = (): Promise<DashboardSnapshot> => Promise.resolve(baseSnapshot);
    const { result } = renderHook(() => useDashboardSession(loadSnapshot));
    await waitFor(() => expect(result.current.loadState).toBe("ready"));
    expect(result.current.snapshot.events).toHaveLength(2);

    await act(async () => {
      await result.current.loadSessionEvents("session-existing");
    });

    await waitFor(() => expect(result.current.snapshot.events).toHaveLength(0));
  });

  it("re-pulls a session's tail from scratch when its events were evicted from the global cap", async () => {
    // Repro of the empty-session bug: switch to a busy session, its stream
    // floods the global newest-N events cap and evicts the idle session's rows,
    // then switch back. The parked cursor makes `eventsSince` return nothing, so
    // the chat renders empty. The self-heal must re-read the tail from scratch.
    const tail = [
      {
        id: "ev-user",
        sessionId: "session-existing",
        type: "user.message",
        message: "hi",
        payload: {},
        createdAt: "2026-05-12T15:00:05.000Z",
        rowCursor: 3
      },
      {
        id: "ev-answer",
        sessionId: "session-existing",
        type: "message.completed",
        message: "hello",
        payload: {},
        createdAt: "2026-05-12T15:00:06.000Z",
        rowCursor: 4
      }
    ];
    const eventsSince = window.argmax!.session.eventsSince as ReturnType<typeof vi.fn>;
    eventsSince.mockResolvedValueOnce({
      events: tail,
      rawOutputs: [],
      eventCursor: 4,
      rawOutputCursor: 0
    });

    const loadSnapshot = (): Promise<DashboardSnapshot> => Promise.resolve(baseSnapshot);
    const { result } = renderHook(() => useDashboardSession(loadSnapshot));
    await waitFor(() => expect(result.current.loadState).toBe("ready"));

    // First focus loads the tail with no cursor and seeds it.
    await act(async () => {
      await result.current.loadSessionEvents("session-existing");
    });
    expect(eventsSince).toHaveBeenLastCalledWith({
      sessionId: "session-existing",
      eventCursor: null,
      rawOutputCursor: null
    });
    expect(result.current.snapshot.events).toHaveLength(2);

    // A busy session floods the shared cap and evicts these rows.
    act(() => {
      result.current.setSnapshot((current) => ({ ...current, events: [] }));
    });

    // Re-focus: pre-fix this fetched with the parked cursor (4) and got nothing.
    eventsSince.mockResolvedValueOnce({
      events: tail,
      rawOutputs: [],
      eventCursor: 4,
      rawOutputCursor: 0
    });
    await act(async () => {
      await result.current.loadSessionEvents("session-existing");
    });

    expect(eventsSince).toHaveBeenLastCalledWith({
      sessionId: "session-existing",
      eventCursor: null,
      rawOutputCursor: null
    });
    expect(result.current.snapshot.events).toHaveLength(2);
  });

  it("keeps backfilled command rows when the global dashboard tail is already full", async () => {
    const busyTail: TimelineEvent[] = Array.from({ length: 500 }, (_, i) => ({
      id: `busy-${i}`,
      sessionId: "busy-session",
      type: "message.completed",
      message: `busy ${i}`,
      payload: {},
      createdAt: new Date(Date.parse("2026-05-12T16:00:00.000Z") + i).toISOString(),
      rowCursor: 1_000 + i
    }));
    baseSnapshot = { ...baseSnapshot, events: busyTail };

    const commandRows: TimelineEvent[] = [
      {
        id: "codex-edit-start",
        sessionId: "session-existing",
        type: "command.started",
        message: "file_change",
        payload: {
          id: "item_4",
          name: "file_change",
          input: { changes: [{ kind: "update", path: "/repo/src/ModelSelector.tsx" }] }
        },
        createdAt: "2026-05-12T15:00:02.000Z",
        rowCursor: 10
      },
      {
        id: "codex-edit-end",
        sessionId: "session-existing",
        type: "command.completed",
        message: "file_change",
        payload: {
          id: "item_4",
          name: "file_change",
          input: { changes: [{ kind: "update", path: "/repo/src/ModelSelector.tsx" }] }
        },
        createdAt: "2026-05-12T15:00:03.000Z",
        rowCursor: 11
      }
    ];
    const eventsSince = window.argmax!.session.eventsSince as ReturnType<typeof vi.fn>;
    eventsSince.mockResolvedValueOnce({
      events: commandRows,
      rawOutputs: [],
      eventCursor: 11,
      rawOutputCursor: 0
    });

    const loadSnapshot = (): Promise<DashboardSnapshot> => Promise.resolve(baseSnapshot);
    const { result } = renderHook(() => useDashboardSession(loadSnapshot));
    await waitFor(() => expect(result.current.loadState).toBe("ready"));
    expect(result.current.snapshot.events).toHaveLength(500);

    await act(async () => {
      await result.current.loadSessionEvents("session-existing");
    });

    const ids = new Set(result.current.snapshot.events.map((event) => event.id));
    expect(ids.has("codex-edit-start")).toBe(true);
    expect(ids.has("codex-edit-end")).toBe(true);
  });

  it("does not reset the cursor for a session that legitimately has no events", async () => {
    // Guard against the self-heal looping on full re-reads: a session that has
    // never returned events must keep using its incremental cursor.
    const eventsSince = window.argmax!.session.eventsSince as ReturnType<typeof vi.fn>;
    eventsSince.mockResolvedValue({
      events: [],
      rawOutputs: [],
      eventCursor: 7,
      rawOutputCursor: 0
    });

    const loadSnapshot = (): Promise<DashboardSnapshot> => Promise.resolve(baseSnapshot);
    const { result } = renderHook(() => useDashboardSession(loadSnapshot));
    await waitFor(() => expect(result.current.loadState).toBe("ready"));

    await act(async () => {
      await result.current.loadSessionEvents("session-existing");
    });
    await act(async () => {
      await result.current.loadSessionEvents("session-existing");
    });

    // Never seeded → no heal → second call keeps the advanced cursor.
    expect(eventsSince).toHaveBeenLastCalledWith({
      sessionId: "session-existing",
      eventCursor: 7,
      rawOutputCursor: 0
    });
  });

  it("rolls back only the failed approval when approval resolves overlap", async () => {
    const approvalA: ApprovalRequest = {
      id: "approval-a",
      sessionId: "session-existing",
      command: "npm test",
      cwd: "/tmp/existing",
      provider: "claude",
      providerInvocationId: null,
      providerRequestId: null,
      riskLevel: "low",
      status: "pending",
      createdAt: "2026-05-12T15:00:02.000Z",
      resolvedAt: null
    };
    const approvalB: ApprovalRequest = {
      ...approvalA,
      id: "approval-b",
      command: "npm run lint",
      createdAt: "2026-05-12T15:00:03.000Z"
    };
    baseSnapshot = { ...baseSnapshot, approvals: [approvalA, approvalB] };

    let rejectA!: (error: Error) => void;
    const pendingA = new Promise<ApprovalRequest>((_resolve, reject) => {
      rejectA = reject;
    });
    const pendingB = new Promise<ApprovalRequest>(() => undefined);
    resolveApprovalMock.mockImplementation((input) =>
      input.approvalId === "approval-a" ? pendingA : pendingB
    );

    const loadSnapshot = (): Promise<DashboardSnapshot> => Promise.resolve(baseSnapshot);
    const { result } = renderHook(() => useDashboardSession(loadSnapshot));
    await waitFor(() => expect(result.current.snapshot.approvals).toHaveLength(2));

    let resolveA!: Promise<void>;
    act(() => {
      resolveA = result.current.resolveApproval("approval-a", "approved");
    });
    await waitFor(() =>
      expect(result.current.snapshot.approvals.find((approval) => approval.id === "approval-a")?.status).toBe(
        "approved"
      )
    );

    act(() => {
      void result.current.resolveApproval("approval-b", "rejected");
    });
    await waitFor(() =>
      expect(result.current.snapshot.approvals.find((approval) => approval.id === "approval-b")?.status).toBe(
        "rejected"
      )
    );

    await act(async () => {
      rejectA(new Error("approval failed"));
      await resolveA;
    });

    expect(result.current.snapshot.approvals.find((approval) => approval.id === "approval-a")?.status).toBe(
      "pending"
    );
    expect(result.current.snapshot.approvals.find((approval) => approval.id === "approval-b")?.status).toBe(
      "rejected"
    );
  });
});
