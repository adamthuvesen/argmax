import { describe, expect, it } from "vitest";
import type { ProjectSummary, WorkspaceSummary } from "../../shared/types.js";
import { findSharedCheckoutWorkspace } from "./projectCheckoutWorkspace.js";

function makeProject(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
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
    latestActivityAt: null,
    ...overrides
  };
}

function makeWorkspace(overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    id: "workspace-shared",
    projectId: "project-1",
    taskLabel: "Argmax",
    branch: "main",
    baseRef: "main",
    path: "/tmp/argmax",
    state: "created",
    sharedWorkspace: true,
    kind: "git",
    dirty: false,
    changedFiles: 0,
    lastActivityAt: "2026-05-08T15:00:00.000Z",
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
    prActivityAt: null,
    ...overrides
  };
}

describe("findSharedCheckoutWorkspace", () => {
  it("returns the shared workspace whose path matches the project checkout", () => {
    const project = makeProject();
    const workspaces = [
      makeWorkspace({ id: "w-worktree", path: "/tmp/worktrees/feature", sharedWorkspace: false }),
      makeWorkspace({ id: "w-shared", path: "/tmp/argmax/" })
    ];

    expect(findSharedCheckoutWorkspace(project, workspaces)?.id).toBe("w-shared");
  });

  it("ignores archived shared workspaces at the checkout", () => {
    const project = makeProject();
    const workspaces = [makeWorkspace({ state: "archived" })];

    expect(findSharedCheckoutWorkspace(project, workspaces)).toBeNull();
  });
});
