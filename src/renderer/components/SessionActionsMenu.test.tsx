import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary, WorkspaceSummary } from "../../shared/types.js";
import { SessionActionsMenu } from "./SessionActionsMenu.js";

function installArgmax(listForSession: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(window, "argmax", {
    configurable: true,
    writable: true,
    value: {
      prs: {
        listForSession
      },
      git: {
        push: vi.fn(),
        createBranch: vi.fn(),
        viewOrCreatePr: vi.fn()
      }
    }
  });
}

function session(): SessionSummary {
  return {
    id: "session-1",
    workspaceId: "workspace-1",
    provider: "codex",
    modelLabel: "GPT-5.3 Codex",
    modelId: "gpt-5.5",
    permissionMode: "auto-approve",
    agentMode: "auto",
    providerConversationId: null,
    prompt: "go",
    state: "complete",
    attention: "normal",
    startedAt: "2026-05-12T15:00:00.000Z",
    completedAt: "2026-05-12T15:00:01.000Z",
    lastActivityAt: "2026-05-12T15:00:01.000Z"
  };
}

function workspace(overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    id: "workspace-1",
    projectId: "project-1",
    taskLabel: "Tidy chat",
    branch: "feature/tidy-chat",
    baseRef: "main",
    path: "/repo",
    state: "complete",
    sharedWorkspace: false,
    dirty: false,
    changedFiles: 0,
    lastActivityAt: "2026-05-12T15:00:01.000Z",
    pinned: false,
    ...overrides
  };
}

describe("SessionActionsMenu", () => {
  let listForSession: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    listForSession = vi.fn().mockResolvedValue([]);
    installArgmax(listForSession);
  });

  afterEach(() => {
    cleanup();
    delete (window as { argmax?: unknown }).argmax;
  });

  it("hides actions until opened and routes main menu clicks", async () => {
    const onBrowseFiles = vi.fn();
    const onCreateCheckpoint = vi.fn().mockResolvedValue(undefined);
    const onToggleLog = vi.fn();
    render(
      <SessionActionsMenu
        isLogOpen={false}
        onBrowseFiles={onBrowseFiles}
        onCreateCheckpoint={onCreateCheckpoint}
        onToggleLog={onToggleLog}
        session={session()}
        workspace={workspace({ dirty: true })}
      />
    );

    expect(screen.queryByRole("menuitem", { name: "Browse files" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));

    expect(screen.getByRole("menuitem", { name: "Browse files" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Browse files" }));
    expect(onBrowseFiles).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menuitem", { name: "Browse files" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Save checkpoint" }));
    expect(onCreateCheckpoint).toHaveBeenCalledWith("workspace-1");

    await waitFor(() => {
      expect(listForSession).toHaveBeenCalledWith({ sessionId: "session-1" });
    });
  });

  it("switches between the main menu and git actions in place", async () => {
    render(
      <SessionActionsMenu
        isLogOpen
        onBrowseFiles={() => {}}
        onCreateCheckpoint={() => Promise.resolve()}
        onOpenCommitDialog={() => {}}
        onToggleLog={() => {}}
        session={session()}
        workspace={workspace()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Git actions" }));

    expect(screen.queryByRole("menuitem", { name: "Browse files" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Push" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Create pull request" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to session actions" }));
    expect(screen.getByRole("menuitem", { name: "Browse files" })).toBeInTheDocument();

    await waitFor(() => {
      expect(listForSession).toHaveBeenCalledWith({ sessionId: "session-1" });
    });
  });
});
