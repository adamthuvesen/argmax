import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSummary } from "../../shared/types.js";
import type { AsyncState } from "../hooks/useReviewState.js";
import { baseSession, workspace } from "../../test/sessionConversationTestHarness.js";
import type { SubagentCluster } from "../lib/subagentSummary.js";
import { WorkspaceCard } from "./WorkspaceCard.js";

function subagentCluster(overrides: Partial<SubagentCluster> = {}): SubagentCluster {
  return {
    entries: [
      { toolUseId: "spawn-1", codename: "Io", title: "Map the renderer", status: "done", iconColor: "blue", multitask: false },
      { toolUseId: "spawn-2", codename: "Titan", title: "Sweep tests", status: "running", iconColor: "amber", multitask: false }
    ],
    running: 1,
    done: 1,
    failed: 0,
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

  it("offers to create a pull request when the workspace has none, and to open the one it has", async () => {
    const viewOrCreatePr = vi.fn().mockResolvedValue({ action: "created", url: "https://x/1", prNumber: 1 });
    (window as { argmax?: unknown }).argmax = { git: { viewOrCreatePr } };
    const setStatus = vi.fn();

    const { rerender } = renderCard({ setStatus });
    fireEvent.click(screen.getByRole("button", { name: "Create pull request" }));
    expect(viewOrCreatePr).toHaveBeenCalledWith({ sessionId: "session-a" });
    await waitFor(() =>
      expect(setStatus).toHaveBeenCalledWith({
        kind: "info",
        message: "Created pull request. Opening https://x/1."
      })
    );

    rerender(
      <WorkspaceCard
        changeSummary={{ fileCount: 1, additions: 1, deletions: 0 }}
        changesState="ready"
        isTerminalOpen={false}
        onBrowseFiles={vi.fn()}
        onHide={vi.fn()}
        onOpenChanges={vi.fn()}
        onOpenCommitDialog={vi.fn()}
        onToggleTerminal={vi.fn()}
        session={baseSession()}
        setStatus={vi.fn()}
        workspace={{ ...workspace, prNumber: 1158, prState: "OPEN" }}
      />
    );

    const prRow = screen.getByRole("button", { name: "PR #1158" });
    expect(prRow.textContent).toContain("open");

    rerender(
      <WorkspaceCard
        changeSummary={{ fileCount: 1, additions: 1, deletions: 0 }}
        changesState="ready"
        isTerminalOpen={false}
        onBrowseFiles={vi.fn()}
        onHide={vi.fn()}
        onOpenChanges={vi.fn()}
        onOpenCommitDialog={vi.fn()}
        onToggleTerminal={vi.fn()}
        session={baseSession()}
        setStatus={vi.fn()}
        workspace={{ ...workspace, prNumber: 1158, prState: "MERGED" }}
      />
    );

    expect(screen.getByRole("button", { name: "PR #1158" })).toHaveTextContent("merged");
  });

  it("reports a failed pull-request call through the session status line", async () => {
    const setStatus = vi.fn();
    (window as { argmax?: unknown }).argmax = {
      git: { viewOrCreatePr: vi.fn().mockRejectedValue(new Error("gh not authenticated")) }
    };

    renderCard({ setStatus });
    fireEvent.click(screen.getByRole("button", { name: "Create pull request" }));

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

  it("shows the subagent roster with a per-state count once the session spawns agents", () => {
    renderCard({ subagents: subagentCluster() });

    const section = screen.getByRole("region", { name: "Subagents" });
    expect(section.textContent).toContain("1 running");
    expect(section.textContent).toContain("1 done");
    // Codenames surface in the hover roster, one chip per launch.
    const roster = section.querySelector(".workspace-card-subagents");
    expect(roster?.getAttribute("title")).toContain("Io — Completed");
    expect(roster?.getAttribute("title")).toContain("Titan — Running");
    expect(section.querySelectorAll(".workspace-card-agent")).toHaveLength(2);
  });

  it("opens the Agents view from the subagent roster", () => {
    const onOpenAgents = vi.fn();
    renderCard({ subagents: subagentCluster(), onOpenAgents });

    fireEvent.click(screen.getByRole("button", { name: "Open Subagents" }));

    expect(onOpenAgents).toHaveBeenCalledTimes(1);
  });

  it("folds the avatar stack into a +N chip beyond five launches and reports failures", () => {
    const entries = Array.from({ length: 7 }, (_, index) => ({
      toolUseId: `spawn-${index}`,
      codename: `Scientist${index}`,
      title: `Agent ${index}`,
      status: index === 6 ? ("error" as const) : ("done" as const),
      iconColor: "blue",
      multitask: false
    }));
    renderCard({ subagents: { entries, running: 0, done: 6, failed: 1, hasMultitask: false } });

    const section = screen.getByRole("region", { name: "Subagents" });
    expect(section.querySelectorAll(".workspace-card-agent")).toHaveLength(6); // 5 chips + "+2"
    expect(section.textContent).toContain("+2");
    expect(section.textContent).toContain("1 failed");
    expect(section.textContent).toContain("6 done");
  });

  it("names the section for what is in it once a multitask joins", () => {
    renderCard({ subagents: subagentCluster({ hasMultitask: true }) });

    expect(screen.getByRole("region", { name: "Alongside" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Subagents" })).toBeNull();
  });

  it("keeps the subagents section out of a session that never spawned one", () => {
    renderCard({ subagents: null });

    expect(screen.queryByRole("region", { name: "Subagents" })).toBeNull();
  });
});
