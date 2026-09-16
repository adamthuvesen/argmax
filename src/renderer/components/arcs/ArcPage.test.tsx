import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ArcMemberSummary,
  ArcRecord,
  ArgmaxApi,
  DashboardSnapshot,
  ProjectSummary,
  Routine
} from "../../../shared/types.js";
import { ArcPage } from "./ArcPage.js";

const PROJECT: ProjectSummary = {
  id: "project-1",
  name: "Argmax",
  repoPath: "/tmp/argmax",
  currentBranch: "main",
  defaultBranch: "main",
  settings: {
    archiveOnMerge: false,
    worktreeLocation: "/tmp/worktrees",
    setupCommand: "",
    checkCommands: []
  },
  counts: { active: 0, blocked: 0, failed: 0, reviewReady: 0 },
  latestActivityAt: "2026-05-12T15:54:00.000Z"
};

function arcRecord(overrides: Partial<ArcRecord> = {}): ArcRecord {
  return {
    id: "arc-1",
    name: "Pricing rollout",
    brief: "Ship the new pricing tiers.",
    state: "active",
    homeProjectId: "project-1",
    coordinatorSessionId: "session-coord",
    dir: "/tmp/arcs/arc-1",
    createdAt: "2026-05-10T09:00:00.000Z",
    updatedAt: "2026-05-12T15:54:00.000Z",
    ...overrides
  };
}

const SNAPSHOT: DashboardSnapshot = {
  projects: [PROJECT],
  workspaces: [
    {
      id: "workspace-coord",
      projectId: "project-1",
      taskLabel: "Coordinate pricing rollout",
      branch: "argmax/pricing-coordinator",
      baseRef: "main",
      path: "/tmp/argmax",
      state: "running",
      sharedWorkspace: true,
      kind: "git",
      dirty: false,
      changedFiles: 0,
      lastActivityAt: "2026-05-12T15:54:00.000Z",
      pinned: false,
      priorityDismissedAt: null,
      priorityAddedAt: null,
      prState: null,
      prNumber: null,
      icon: null,
      iconColor: null,
      prCreatedAt: null,
      prMergedAt: null,
      prCheckState: null,
      prActivityAt: null
    },
    {
      id: "workspace-member",
      projectId: "project-1",
      taskLabel: "Ship the pricing page",
      branch: "argmax/pricing-page",
      baseRef: "main",
      path: "/tmp/wt-pricing-page",
      state: "complete",
      sharedWorkspace: false,
      kind: "git",
      dirty: false,
      changedFiles: 0,
      lastActivityAt: "2026-05-12T15:50:00.000Z",
      pinned: false,
      priorityDismissedAt: null,
      priorityAddedAt: null,
      prState: "OPEN",
      prNumber: 42,
      icon: null,
      iconColor: null,
      prCreatedAt: null,
      prMergedAt: null,
      prCheckState: null,
      prActivityAt: null
    }
  ],
  sessions: [
    {
      id: "session-coord",
      workspaceId: "workspace-coord",
      provider: "claude",
      modelLabel: "Sonnet",
      modelId: "sonnet",
      permissionMode: "auto-approve",
      providerConversationId: null,
      prompt: "Coordinate the pricing rollout arc.",
      state: "running",
      attention: "normal",
      startedAt: "2026-05-10T09:00:00.000Z",
      completedAt: null,
      lastActivityAt: "2026-05-12T15:54:00.000Z",
      costUsd: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextTokens: 0,
      imported: false,
      launchKind: "agent",
      arcId: "arc-1"
    },
    {
      id: "session-member",
      workspaceId: "workspace-member",
      provider: "codex",
      modelLabel: "GPT-5.3 Codex",
      modelId: "gpt-5.5",
      permissionMode: "auto-approve",
      providerConversationId: null,
      prompt: "Ship the pricing page.",
      state: "complete",
      attention: "normal",
      startedAt: "2026-05-11T09:00:00.000Z",
      completedAt: "2026-05-11T10:00:00.000Z",
      lastActivityAt: "2026-05-12T15:50:00.000Z",
      costUsd: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextTokens: 0,
      imported: false,
      launchKind: "agent",
      arcId: "arc-1"
    }
  ],
  events: [],
  rawOutputs: [],
  approvals: [],
  checks: [],
  arcs: [
    {
      id: "arc-1",
      name: "Pricing rollout",
      state: "active",
      homeProjectId: "project-1",
      coordinatorSessionId: "session-coord",
      dir: "/tmp/arcs/arc-1",
      memberCount: 1,
      updatedAt: "2026-05-12T15:54:00.000Z"
    }
  ]
};

function member(overrides: Partial<ArcMemberSummary> = {}): ArcMemberSummary {
  return {
    sessionId: "session-member",
    taskLabel: "Ship the pricing page",
    projectId: "project-1",
    projectName: "Argmax",
    workspaceId: "workspace-member",
    state: "complete",
    provider: "codex",
    modelLabel: "GPT-5.3 Codex",
    modelId: "gpt-5.5",
    startedAt: "2026-05-11T09:00:00.000Z",
    isCoordinator: false,
    prNumber: 42,
    prState: "OPEN",
    ...overrides
  };
}

const COORDINATOR_MEMBER = member({
  sessionId: "session-coord",
  taskLabel: "Coordinate pricing rollout",
  workspaceId: "workspace-coord",
  state: "running",
  provider: "claude",
  modelLabel: "Sonnet",
  modelId: "sonnet",
  startedAt: "2026-05-10T09:00:00.000Z",
  isCoordinator: true,
  prNumber: null,
  prState: null
});

const arcsStub = {
  get: vi.fn<ArgmaxApi["arcs"]["get"]>(),
  list: vi.fn<ArgmaxApi["arcs"]["list"]>(),
  create: vi.fn<ArgmaxApi["arcs"]["create"]>(),
  update: vi.fn<ArgmaxApi["arcs"]["update"]>(),
  setState: vi.fn<ArgmaxApi["arcs"]["setState"]>(),
  launchCoordinator: vi.fn<ArgmaxApi["arcs"]["launchCoordinator"]>()
};

const systemStub = {
  confirm: vi.fn<ArgmaxApi["system"]["confirm"]>()
};

const routinesStub = {
  list: vi.fn<ArgmaxApi["routines"]["list"]>(),
  upsert: vi.fn<ArgmaxApi["routines"]["upsert"]>(),
  delete: vi.fn<ArgmaxApi["routines"]["delete"]>(),
  setEnabled: vi.fn<ArgmaxApi["routines"]["setEnabled"]>(),
  runNow: vi.fn<ArgmaxApi["routines"]["runNow"]>(),
  resetSession: vi.fn<ArgmaxApi["routines"]["resetSession"]>()
};

function routine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: "routine-1",
    name: "Morning triage",
    projectId: "project-1",
    prompt: "Triage the arc.\nCheck blockers first.",
    provider: "claude",
    modelLabel: "Sonnet",
    modelId: "sonnet",
    worktree: false,
    runTarget: "arc_coordinator",
    lastSessionId: null,
    arcId: "arc-1",
    cronExpr: "0 0 9 * * *",
    runOnceAt: null,
    enabled: true,
    lastRunAt: null,
    nextRunAt: "2026-05-13T09:00:00.000Z",
    lastError: null,
    createdBy: "user",
    createdAt: "2026-05-10T09:00:00.000Z",
    updatedAt: "2026-05-10T09:00:00.000Z",
    ...overrides
  };
}

beforeEach(() => {
  arcsStub.get.mockReset();
  arcsStub.update.mockReset();
  arcsStub.setState.mockReset();
  arcsStub.launchCoordinator.mockReset();
  systemStub.confirm.mockReset();
  routinesStub.list.mockReset();
  routinesStub.delete.mockReset();

  arcsStub.get.mockResolvedValue({
    arc: arcRecord(),
    members: [COORDINATOR_MEMBER, member()],
    membersTruncated: false,
    launchesLast24h: 3,
    limits: { maxActiveMembers: 8, maxLaunchesPerDay: 40 }
  });
  arcsStub.update.mockImplementation((input) =>
    Promise.resolve({
      ...arcRecord(),
      ...(input.name !== null ? { name: input.name } : {}),
      ...(input.brief !== null ? { brief: input.brief } : {})
    })
  );
  arcsStub.setState.mockImplementation((input) => Promise.resolve(arcRecord({ state: input.state })));
  arcsStub.launchCoordinator.mockImplementation((input) =>
    Promise.resolve(arcRecord({ coordinatorSessionId: `relaunched-${input.provider}` }))
  );
  systemStub.confirm.mockResolvedValue(true);
  routinesStub.list.mockResolvedValue([
    routine(),
    routine({ id: "routine-other-arc", name: "Other arc task", arcId: "arc-2" })
  ]);
  routinesStub.delete.mockResolvedValue(null);

  window.argmax = { arcs: arcsStub, system: systemStub, routines: routinesStub } as unknown as ArgmaxApi;
});

afterEach(() => {
  cleanup();
  delete (window as { argmax?: ArgmaxApi }).argmax;
});

describe("ArcPage", () => {
  it("saves an edited brief", async () => {
    const onOpenSession = vi.fn();
    render(
      <ArcPage arcId="arc-1" snapshot={SNAPSHOT} projects={[PROJECT]} onOpenSession={onOpenSession} />
    );

    const textarea = await screen.findByPlaceholderText("What this arc is for, and what done looks like.");
    fireEvent.change(textarea, { target: { value: "Ship the new pricing tiers, then deprecate the old ones." } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(arcsStub.update).toHaveBeenCalledTimes(1));
    expect(arcsStub.update).toHaveBeenCalledWith({
      id: "arc-1",
      name: null,
      brief: "Ship the new pricing tiers, then deprecate the old ones."
    });
  });

  it("pauses an active arc", async () => {
    render(<ArcPage arcId="arc-1" snapshot={SNAPSHOT} projects={[PROJECT]} onOpenSession={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));

    await waitFor(() => expect(arcsStub.setState).toHaveBeenCalledTimes(1));
    expect(arcsStub.setState).toHaveBeenCalledWith({ id: "arc-1", state: "paused" });
  });

  it("confirms and launches a new coordinator", async () => {
    render(<ArcPage arcId="arc-1" snapshot={SNAPSHOT} projects={[PROJECT]} onOpenSession={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "New coordinator" }));

    await waitFor(() => expect(systemStub.confirm).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(arcsStub.launchCoordinator).toHaveBeenCalledTimes(1));
    expect(arcsStub.launchCoordinator).toHaveBeenCalledWith(
      expect.objectContaining({ arcId: "arc-1", provider: "claude" })
    );
  });

  it("does not launch a new coordinator when the confirmation is declined", async () => {
    systemStub.confirm.mockResolvedValue(false);
    render(<ArcPage arcId="arc-1" snapshot={SNAPSHOT} projects={[PROJECT]} onOpenSession={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "New coordinator" }));

    await waitFor(() => expect(systemStub.confirm).toHaveBeenCalledTimes(1));
    expect(arcsStub.launchCoordinator).not.toHaveBeenCalled();
  });

  it("lists members and excludes the coordinator", async () => {
    render(<ArcPage arcId="arc-1" snapshot={SNAPSHOT} projects={[PROJECT]} onOpenSession={vi.fn()} />);

    expect(await screen.findByRole("button", { name: /Ship the pricing page/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Coordinate pricing rollout/ })).not.toBeInTheDocument();
    expect(screen.getByText("Launched in the last 24h: 3 of 40")).toBeInTheDocument();
  });

  it("shows a member that aged out of the recent chat list without an open action", async () => {
    arcsStub.get.mockResolvedValue({
      arc: arcRecord(),
      members: [COORDINATOR_MEMBER, member(), member({ sessionId: "session-old", taskLabel: "Migrate old tiers" })],
      membersTruncated: false,
      launchesLast24h: 0,
      limits: { maxActiveMembers: 8, maxLaunchesPerDay: 40 }
    });
    render(<ArcPage arcId="arc-1" snapshot={SNAPSHOT} projects={[PROJECT]} onOpenSession={vi.fn()} />);

    const old = await screen.findByRole("button", { name: /Migrate old tiers/ });
    expect(old).toBeDisabled();
    expect(old).toHaveAttribute("title", "This chat is no longer in the recent chat list");
    expect(screen.getByRole("button", { name: /Ship the pricing page/ })).toBeEnabled();
  });

  it("keeps an unsaved brief and stays rendered when the dashboard refreshes", async () => {
    const { rerender } = render(
      <ArcPage arcId="arc-1" snapshot={SNAPSHOT} projects={[PROJECT]} onOpenSession={vi.fn()} />
    );
    const textarea = await screen.findByPlaceholderText("What this arc is for, and what done looks like.");
    fireEvent.change(textarea, { target: { value: "Half-typed brief" } });

    const refreshed: DashboardSnapshot = {
      ...SNAPSHOT,
      arcs: (SNAPSHOT.arcs ?? []).map((arc) => ({ ...arc, memberCount: 2, updatedAt: "2026-05-12T16:00:00.000Z" }))
    };
    rerender(<ArcPage arcId="arc-1" snapshot={refreshed} projects={[PROJECT]} onOpenSession={vi.fn()} />);

    await waitFor(() => expect(arcsStub.get).toHaveBeenCalledTimes(2));
    expect(screen.getByPlaceholderText("What this arc is for, and what done looks like.")).toHaveValue(
      "Half-typed brief"
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("lists only this arc's scheduled tasks in Triggers", async () => {
    render(<ArcPage arcId="arc-1" snapshot={SNAPSHOT} projects={[PROJECT]} onOpenSession={vi.fn()} />);

    await waitFor(() => expect(routinesStub.list).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Triage the arc.")).toBeInTheDocument();
    expect(screen.queryByText("Other arc task")).not.toBeInTheDocument();
  });

  it("removes a trigger after confirming", async () => {
    render(<ArcPage arcId="arc-1" snapshot={SNAPSHOT} projects={[PROJECT]} onOpenSession={vi.fn()} />);

    await screen.findByText("Triage the arc.");
    fireEvent.click(screen.getByRole("button", { name: "Remove Morning triage" }));

    await waitFor(() => expect(systemStub.confirm).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(routinesStub.delete).toHaveBeenCalledWith("routine-1"));
    await waitFor(() => expect(routinesStub.list).toHaveBeenCalledTimes(2));
  });

  it("does not delete a trigger when the confirmation is declined", async () => {
    systemStub.confirm.mockResolvedValue(false);
    render(<ArcPage arcId="arc-1" snapshot={SNAPSHOT} projects={[PROJECT]} onOpenSession={vi.fn()} />);

    await screen.findByText("Triage the arc.");
    fireEvent.click(screen.getByRole("button", { name: "Remove Morning triage" }));

    await waitFor(() => expect(systemStub.confirm).toHaveBeenCalledTimes(1));
    expect(routinesStub.delete).not.toHaveBeenCalled();
  });
});
