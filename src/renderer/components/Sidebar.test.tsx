import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardSnapshot } from "../../shared/types.js";
import { collapsedProjectsStorageKey } from "../lib/projects.js";
import { Sidebar } from "./Sidebar.js";

const snapshot: DashboardSnapshot = {
  projects: [
    {
      id: "project-1",
      name: "Argmax",
      repoPath: "/tmp/argmax",
      currentBranch: "main",
      defaultBranch: "main",
      settings: {
        defaultProvider: "codex",
        defaultModelLabel: "GPT-5.3 Codex",
        worktreeLocation: "/tmp/worktrees",
        setupCommand: "",
        checkCommands: []
      },
      counts: { active: 1, blocked: 0, failed: 0, reviewReady: 0 },
      latestActivityAt: "2026-05-12T15:54:00.000Z"
    }
  ],
  workspaces: [
    {
      id: "workspace-1",
      projectId: "project-1",
      taskLabel: "Build dashboard",
      branch: "argmax/dashboard",
      baseRef: "main",
      path: "/tmp/wt",
      state: "running",
      sharedWorkspace: false,
      dirty: false,
      changedFiles: 0,
      lastActivityAt: "2026-05-12T15:54:00.000Z",
      pinned: false
    }
  ],
  sessions: [],
  events: [],
  rawOutputs: [],
  approvals: [],
  checks: [],
  checkpoints: []
};

const noop = (): void => {};

describe("Sidebar — localStorage write isolation", () => {
  let setItemSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    window.localStorage.clear();
    setItemSpy = vi.spyOn(Storage.prototype, "setItem");
  });

  afterEach(() => {
    cleanup();
    setItemSpy.mockRestore();
  });

  it("writes the collapsed-projects key exactly once per chevron click under StrictMode", () => {
    // audit-2026-05-11 / SPEC P1.08 — saving inside the setState updater
    // would persist twice when StrictMode double-invokes the updater in
    // dev. The fix computes `next` outside the updater and calls the
    // storage writer exactly once per user action.
    render(
      <StrictMode>
        <Sidebar
          loadState="ready"
          onAddProject={noop}
          onArchiveWorkspace={noop}
          onOpenInIde={noop}
          onOpenLauncher={noop}
          onOpenProject={noop}
          onOpenSettings={noop}
          onOpenWorkspaceChat={noop}
          onResizeMouseDown={noop}
          isSettingsActive={false}
          selectedProjectId={null}
          selectedWorkspaceId={null}
          openWorkspaceIds={new Set()}
          canDragWorkspaceToGrid={false}
          snapshot={snapshot}
          detectedIdes={[]}
          defaultIde={null}
          showSessionTokens={false}
        />
      </StrictMode>
    );

    const chevron = screen.getByRole("button", { name: "Hide Argmax sessions" });
    fireEvent.click(chevron);

    const collapsedWrites = setItemSpy.mock.calls.filter(
      ([key]) => key === collapsedProjectsStorageKey
    );
    expect(collapsedWrites).toHaveLength(1);
    expect(collapsedWrites[0]?.[1]).toBe(JSON.stringify(["project-1"]));
  });

  it("writes the collapsed-projects key exactly once per expand click under StrictMode", () => {
    // Same property, the inverse direction. Persist the collapsed state first
    // (so the chevron starts in the "Show" position), then expand and assert
    // a single write back to the empty array.
    window.localStorage.setItem(collapsedProjectsStorageKey, JSON.stringify(["project-1"]));

    render(
      <StrictMode>
        <Sidebar
          loadState="ready"
          onAddProject={noop}
          onArchiveWorkspace={noop}
          onOpenInIde={noop}
          onOpenLauncher={noop}
          onOpenProject={noop}
          onOpenSettings={noop}
          onOpenWorkspaceChat={noop}
          onResizeMouseDown={noop}
          isSettingsActive={false}
          selectedProjectId={null}
          selectedWorkspaceId={null}
          openWorkspaceIds={new Set()}
          canDragWorkspaceToGrid={false}
          snapshot={snapshot}
          detectedIdes={[]}
          defaultIde={null}
          showSessionTokens={false}
        />
      </StrictMode>
    );

    setItemSpy.mockClear();

    const chevron = screen.getByRole("button", { name: "Show Argmax sessions" });
    fireEvent.click(chevron);

    const collapsedWrites = setItemSpy.mock.calls.filter(
      ([key]) => key === collapsedProjectsStorageKey
    );
    expect(collapsedWrites).toHaveLength(1);
    expect(collapsedWrites[0]?.[1]).toBe(JSON.stringify([]));
  });
});
