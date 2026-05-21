import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ApprovalRequest,
  ArgmaxApi,
  DashboardDelta,
  DashboardSnapshot,
  SessionSummary,
  WorkspaceSummary
} from "../../shared/types.js";
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
    dirty: false,
    changedFiles: 0,
    lastActivityAt: "2026-05-12T15:00:00.000Z",
    pinned: false,
    ...overrides
  };
}

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "session-existing",
    workspaceId: "ws-existing",
    provider: "claude",
    modelLabel: "Claude Haiku 4.5",
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
    preferred: false,
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
            defaultProvider: "claude",
            defaultModelLabel: "Claude Haiku 4.5",
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
      checkpoints: [],
      pendingMessages: {}
    };

    statusMock = vi
      .fn<ArgmaxApi["workspaces"]["status"]>()
      .mockResolvedValue({
        workspaces: baseSnapshot.workspaces,
        sessions: baseSnapshot.sessions,
        checks: baseSnapshot.checks,
        checkpoints: baseSnapshot.checkpoints
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
      checks: baseSnapshot.checks,
      checkpoints: baseSnapshot.checkpoints
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
      riskLevel: "low",
      status: "pending",
      createdAt: "2026-05-12T15:00:02.000Z",
      resolvedAt: null
    };
    baseSnapshot = { ...baseSnapshot, approvals: [pending] };

    statusMock.mockResolvedValue({
      workspaces: baseSnapshot.workspaces,
      sessions: baseSnapshot.sessions,
      checks: baseSnapshot.checks,
      checkpoints: baseSnapshot.checkpoints
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

  it("surfaces refresh errors after earlier refreshes have bumped the refresh token", async () => {
    const loadSnapshot = (): Promise<DashboardSnapshot> => Promise.resolve(baseSnapshot);
    const { result } = renderHook(() => useDashboardSession(loadSnapshot));
    await waitFor(() => expect(result.current.loadState).toBe("ready"));

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.loadState).toBe("ready");

    statusMock.mockRejectedValueOnce(new Error("status refresh failed"));

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.loadState).toBe("error");
    expect(result.current.loadError).toBe("status refresh failed");
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

  it("rolls back only the failed approval when approval resolves overlap", async () => {
    const approvalA: ApprovalRequest = {
      id: "approval-a",
      sessionId: "session-existing",
      command: "npm test",
      cwd: "/tmp/existing",
      provider: "claude",
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
