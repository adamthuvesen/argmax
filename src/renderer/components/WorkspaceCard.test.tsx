import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSummary } from "../../shared/types.js";
import type { AsyncState } from "../hooks/useReviewState.js";
import { baseSession, workspace } from "../../test/sessionConversationTestHarness.js";
import { emblemForCodename, emblemForKey } from "../lib/agentEmblems.js";
import type { WorkspaceSessionPr } from "../lib/sessionPrs.js";
import type { SubagentCluster } from "../lib/subagentSummary.js";
import { WorkspaceCard } from "./WorkspaceCard.js";

function sessionPr(overrides: Partial<WorkspaceSessionPr> = {}): WorkspaceSessionPr {
  return {
    sessionId: "session-a",
    prNumber: 762,
    url: "https://github.com/o/r/pull/762",
    title: "Alfred Slack status",
    prState: "OPEN",
    headRefName: "feat/alfred-slack-status",
    relationship: "worked",
    activityAt: "2026-05-12T15:54:00.000Z",
    updatedAt: "2026-05-12T15:54:00.000Z",
    checkState: "success",
    isPrimary: true,
    isPinned: false,
    refreshError: null,
    ...overrides
  };
}

function workspaceWithPrs(prs: WorkspaceSessionPr[], overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return { ...workspace, ...overrides, prs };
}

function subagentCluster(overrides: Partial<SubagentCluster> = {}): SubagentCluster {
  return {
    entries: [
      { toolUseId: "spawn-1", codename: "Io", title: "Map the renderer", status: "done", iconColor: "blue", emblem: emblemForCodename("Gauss"), multitask: false },
      { toolUseId: "spawn-2", codename: "Titan", title: "Sweep tests", status: "running", iconColor: "amber", emblem: emblemForCodename("Hopper"), multitask: false }
    ],
    running: 1,
    hasMultitask: false,
    ...overrides
  };
}

function renderCard(
  overrides: {
    changeSummary?: { fileCount: number; additions: number; deletions: number } | null;
    changesState?: AsyncState;
    isTerminalOpen?: boolean;
    onBrowseFiles?: () => void;
    onHide?: () => void;
    onOpenChanges?: () => void;
    onOpenAgents?: () => void;
    onOpenCommitDialog?: () => void;
    onToggleTerminal?: () => void;
    setStatus?: (status: { kind: "error" | "info"; message: string } | null) => void;
    subagents?: SubagentCluster | null;
    workspace?: WorkspaceSummary;
  } = {}
) {
  return render(
    <WorkspaceCard
      changeSummary={
        "changeSummary" in overrides
          ? overrides.changeSummary ?? null
          : { fileCount: 3, additions: 229, deletions: 44 }
      }
      changesState={overrides.changesState ?? "ready"}
      isTerminalOpen={overrides.isTerminalOpen ?? false}
      onBrowseFiles={overrides.onBrowseFiles ?? vi.fn()}
      onHide={overrides.onHide ?? vi.fn()}
      onOpenChanges={overrides.onOpenChanges ?? vi.fn()}
      onOpenAgents={overrides.onOpenAgents}
      onOpenCommitDialog={overrides.onOpenCommitDialog ?? vi.fn()}
      onToggleTerminal={overrides.onToggleTerminal ?? vi.fn()}
      session={baseSession()}
      setStatus={overrides.setStatus ?? vi.fn()}
      subagents={"subagents" in overrides ? overrides.subagents ?? null : undefined}
      workspace={overrides.workspace ?? workspace}
    />
  );
}

describe("WorkspaceCard", () => {
  afterEach(() => {
    cleanup();
    delete (window as { argmax?: unknown }).argmax;
  });

  it("names the branch it is summarizing and the base it came from", () => {
    renderCard();

    const card = screen.getByRole("complementary", { name: "Workspace" });
    expect(card.textContent).toContain("argmax/dashboard");
    expect(card.textContent).toContain("from main");
  });

  it("keeps shared checkout context in the tooltip without a repeated heading", () => {
    renderCard({ workspace: { ...workspace, sharedWorkspace: true } });

    expect(screen.getByTitle("Checkout branch argmax/dashboard · from main")).toBeInTheDocument();
    expect(screen.queryByText("Checkout branch")).not.toBeInTheDocument();
  });

  it("copies the full branch name when its ellipsized label is clicked", async () => {
    const branch = "adam/this-is-a-long-branch-name-that-does-not-fit-in-the-workspace-card";
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    renderCard({ workspace: { ...workspace, branch } });

    const copyButton = screen.getByRole("button", { name: `Copy branch name ${branch}` });
    fireEvent.click(copyButton);

    expect(writeText).toHaveBeenCalledExactlyOnceWith(branch);
    await waitFor(() => expect(copyButton).toHaveAttribute("title", "Copied branch name"));
  });

  it("routes each row to the surface that owns it", () => {
    const onOpenChanges = vi.fn();
    const onBrowseFiles = vi.fn();
    const onToggleTerminal = vi.fn();
    const onOpenCommitDialog = vi.fn();
    renderCard({ onOpenChanges, onBrowseFiles, onToggleTerminal, onOpenCommitDialog });

    fireEvent.click(screen.getByRole("button", { name: "Changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    fireEvent.click(screen.getByRole("button", { name: "Commit" }));

    expect(onOpenChanges).toHaveBeenCalledTimes(1);
    expect(onBrowseFiles).toHaveBeenCalledTimes(1);
    expect(onToggleTerminal).toHaveBeenCalledTimes(1);
    expect(onOpenCommitDialog).toHaveBeenCalledTimes(1);
  });

  it("shows the diff stat and, on a clean worktree, disables the row instead of opening an empty panel", () => {
    const { rerender } = renderCard();
    const changes = screen.getByRole("button", { name: "Changes" });
    expect(changes.textContent).toContain("+229");
    expect(changes.textContent).toContain("-44");
    expect(changes).toBeEnabled();

    rerender(
      <WorkspaceCard
        changeSummary={null}
        changesState="ready"
        isTerminalOpen={false}
        onBrowseFiles={vi.fn()}
        onHide={vi.fn()}
        onOpenChanges={vi.fn()}
        onOpenCommitDialog={vi.fn()}
        onToggleTerminal={vi.fn()}
        session={baseSession()}
        setStatus={vi.fn()}
        workspace={workspace}
      />
    );

    const clean = screen.getByRole("button", { name: "Changes" });
    expect(clean.textContent).toBe("Changes");
    expect(clean).toBeDisabled();
  });

  it("reports the unresolved states until the changed-file list is known", () => {
    const { rerender } = renderCard({ changeSummary: null, changesState: "loading" });

    const loading = screen.getByRole("button", { name: "Changes" });
    expect(loading.textContent).toContain("…");
    expect(loading).toHaveAttribute("title", "Loading changed files…");

    rerender(
      <WorkspaceCard
        changeSummary={null}
        changesState="error"
        isTerminalOpen={false}
        onBrowseFiles={vi.fn()}
        onHide={vi.fn()}
        onOpenChanges={vi.fn()}
        onOpenCommitDialog={vi.fn()}
        onToggleTerminal={vi.fn()}
        session={baseSession()}
        setStatus={vi.fn()}
        workspace={workspace}
      />
    );

    const failed = screen.getByRole("button", { name: "Changes" });
    expect(failed.textContent).toContain("unavailable");
    expect(failed).toHaveAttribute("title", "Could not load the changed files");
  });

  it("marks the terminal row pressed while the terminal panel is open", () => {
    renderCard({ isTerminalOpen: true });

    expect(screen.getByRole("button", { name: "Terminal" })).toHaveAttribute("aria-pressed", "true");
  });

  it("refreshes PR state from GitHub on mount for a git workspace", () => {
    const refresh = vi.fn().mockResolvedValue([]);
    (window as { argmax?: unknown }).argmax = { prs: { refresh } };

    renderCard();
    expect(refresh).toHaveBeenCalledWith({ sessionId: "session-a" });
  });

  it("creates a pull request for the exact checkout branch", async () => {
    const viewOrCreatePr = vi.fn().mockResolvedValue({ action: "created", url: "https://x/1", prNumber: 1 });
    const openPath = vi.fn().mockResolvedValue({ ok: true });
    (window as { argmax?: unknown }).argmax = { git: { viewOrCreatePr }, system: { openPath } };
    const setStatus = vi.fn();

    renderCard({ setStatus });
    fireEvent.click(screen.getByRole("button", { name: "Create PR for checkout branch" }));
    expect(viewOrCreatePr).toHaveBeenCalledWith({
      sessionId: "session-a",
      expectedBranch: "argmax/dashboard"
    });
    await waitFor(() => expect(openPath).toHaveBeenCalledWith({ path: "https://x/1" }));
    expect(setStatus).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("opens an existing pull request by its stored URL without resolving by checkout", () => {
    const viewOrCreatePr = vi.fn();
    const openPath = vi.fn().mockResolvedValue({ ok: true });
    (window as { argmax?: unknown }).argmax = {
      git: { viewOrCreatePr },
      system: { openPath }
    };
    renderCard({ workspace: workspaceWithPrs([sessionPr()]) });

    const prRow = screen.getByRole("button", { name: "PR #762 Alfred Slack status" });
    expect(prRow).toHaveAccessibleDescription("Open pull request #762 on GitHub (open)");
    expect(screen.getByTitle("Alfred Slack status")).toHaveTextContent(/^#762$/);
    fireEvent.click(prRow);

    expect(openPath).toHaveBeenCalledWith({ path: "https://github.com/o/r/pull/762" });
    expect(viewOrCreatePr).not.toHaveBeenCalled();
  });

  it("keeps a PR without a stored URL disabled instead of falling back to creation", () => {
    const viewOrCreatePr = vi.fn();
    (window as { argmax?: unknown }).argmax = { git: { viewOrCreatePr } };
    renderCard({ workspace: workspaceWithPrs([sessionPr({ url: null })]) });

    const prRow = screen.getByRole("button", { name: "PR #762 Alfred Slack status" });
    expect(prRow).toBeDisabled();
    expect(prRow).toHaveAccessibleDescription(/has no URL/);
    expect(viewOrCreatePr).not.toHaveBeenCalled();
  });

  it("shows current PRs first and keeps older associations expandable", () => {
    const prs = [
      sessionPr(),
      sessionPr({ prNumber: 759, url: "https://github.com/o/r/pull/759", title: "Referenced fix", relationship: "referenced", isPrimary: false }),
      sessionPr({ prNumber: 755, url: "https://github.com/o/r/pull/755", title: "Earlier work", prState: "MERGED", isPrimary: false }),
      sessionPr({ prNumber: 750, url: "https://github.com/o/r/pull/750", title: "Candidate", prState: "CLOSED", relationship: "unverified", isPrimary: false })
    ];
    renderCard({ workspace: workspaceWithPrs(prs) });

    const section = screen.getByRole("region", { name: "Pull requests" });
    expect(section).toHaveTextContent("Pull requests4");
    expect(screen.getByRole("button", { name: "PR #759 Referenced fix" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "PR #755 Earlier work" })).toBeNull();

    fireEvent.click(screen.getByText("2 more"));
    expect(screen.getByRole("button", { name: "PR #755 Earlier work" })).toBeInTheDocument();
    expect(screen.getAllByText("feat/alfred-slack-status").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Unverified/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^(Open|Merged|Closed) ·/)).not.toBeInTheDocument();
  });

  it("lets an automatically selected unverified PR be confirmed and pinned", async () => {
    const setPrimary = vi.fn().mockResolvedValue([]);
    (window as { argmax?: unknown }).argmax = {
      prs: { setPrimary, dismiss: vi.fn().mockResolvedValue([]) }
    };
    renderCard({
      workspace: workspaceWithPrs([
        sessionPr({ relationship: "unverified", isPrimary: true, isPinned: false })
      ])
    });

    fireEvent.click(screen.getByRole("button", { name: "Actions for PR #762" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Confirm and make primary" }));

    await waitFor(() =>
      expect(setPrimary).toHaveBeenCalledWith({ sessionId: "session-a", prNumber: 762 })
    );
  });

  it("pins, returns to automatic selection, and removes PR associations", async () => {
    const setPrimary = vi.fn().mockResolvedValue([]);
    const dismiss = vi.fn().mockResolvedValue([]);
    (window as { argmax?: unknown }).argmax = { prs: { setPrimary, dismiss } };
    renderCard({
      workspace: workspaceWithPrs([
        sessionPr({ isPinned: true }),
        sessionPr({ prNumber: 759, url: "https://github.com/o/r/pull/759", title: "Candidate", relationship: "unverified", isPrimary: false })
      ])
    });

    fireEvent.click(screen.getByRole("button", { name: "Actions for PR #759" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Confirm and make primary" }));
    await waitFor(() => expect(setPrimary).toHaveBeenCalledWith({ sessionId: "session-a", prNumber: 759 }));

    fireEvent.click(screen.getByRole("button", { name: "Actions for PR #762" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Automatic selection" }));
    await waitFor(() => expect(setPrimary).toHaveBeenCalledWith({ sessionId: "session-a", prNumber: null }));

    fireEvent.click(screen.getByRole("button", { name: "Actions for PR #762" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from this chat" }));
    await waitFor(() => expect(dismiss).toHaveBeenCalledWith({ sessionId: "session-a", prNumber: 762 }));
  });

  it("reports a failed pull-request call through the session status line", async () => {
    const setStatus = vi.fn();
    (window as { argmax?: unknown }).argmax = {
      git: { viewOrCreatePr: vi.fn().mockRejectedValue(new Error("gh not authenticated")) },
      system: { openPath: vi.fn() }
    };

    renderCard({ setStatus });
    fireEvent.click(screen.getByRole("button", { name: "Create PR for checkout branch" }));

    await waitFor(() =>
      expect(setStatus).toHaveBeenCalledWith({ kind: "error", message: "gh not authenticated" })
    );
  });

  it("hides itself from its own dismiss control", () => {
    const onHide = vi.fn();
    renderCard({ onHide });

    fireEvent.click(screen.getByRole("button", { name: "Hide workspace card" }));

    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it("shows the subagent roster once the session spawns agents", () => {
    renderCard({ subagents: subagentCluster() });

    const section = screen.getByRole("region", { name: "Agents" });
    // Codenames and statuses surface in the hover roster, one chip per launch.
    const roster = section.querySelector(".workspace-card-subagents");
    expect(roster?.getAttribute("title")).toContain("Io — Completed");
    expect(roster?.getAttribute("title")).toContain("Titan — Running");
    expect(section.querySelectorAll(".workspace-card-agent")).toHaveLength(2);
    // Each chip wears its agent's emblem rather than an initial.
    expect(section.querySelectorAll(".workspace-card-agent .agent-emblem[data-shape]")).toHaveLength(2);
  });

  it("opens the Agents view from the subagent roster", () => {
    const onOpenAgents = vi.fn();
    renderCard({ subagents: subagentCluster(), onOpenAgents });

    fireEvent.click(screen.getByRole("button", { name: "Open Agents" }));

    expect(onOpenAgents).toHaveBeenCalledTimes(1);
  });

  it("folds the avatar stack into a +N chip beyond five launches", () => {
    const entries = Array.from({ length: 7 }, (_, index) => ({
      toolUseId: `spawn-${index}`,
      codename: `Scientist${index}`,
      title: `Agent ${index}`,
      status: index === 6 ? ("error" as const) : ("done" as const),
      iconColor: "blue",
      emblem: emblemForCodename(`Scientist${index}`),
      multitask: false
    }));
    renderCard({ subagents: { entries, running: 0, hasMultitask: false } });

    const section = screen.getByRole("region", { name: "Agents" });
    expect(section.querySelectorAll(".workspace-card-agent")).toHaveLength(6); // 5 chips + "+2"
    expect(section.textContent).toContain("+2");
  });

  it("names the section for what is in it once a multitask joins", () => {
    renderCard({ subagents: subagentCluster({ hasMultitask: true }) });

    expect(screen.getByRole("region", { name: "Alongside" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Agents" })).toBeNull();
  });

  // The chip used to fall back to the first letter of the task label, so a
  // multitask sat beside the drawn marks as a bare "M".
  it("draws a multitask's chip as an emblem, never as a letter", () => {
    const emblem = emblemForKey("child-session");
    renderCard({
      subagents: {
        entries: [
          {
            toolUseId: "child-session",
            codename: "Multitask",
            title: "Fix the changelog date",
            status: "running",
            iconColor: emblem.hue,
            emblem,
            multitask: true
          }
        ],
        running: 1,
        hasMultitask: true
      }
    });

    const chip = screen.getByRole("region", { name: "Alongside" }).querySelector(".workspace-card-agent");
    expect(chip?.querySelector("svg")).not.toBeNull();
    expect(chip?.textContent).toBe("");
  });

  it("keeps the subagents section out of a session that never spawned one", () => {
    renderCard({ subagents: null });

    expect(screen.queryByRole("region", { name: "Agents" })).toBeNull();
  });
});
