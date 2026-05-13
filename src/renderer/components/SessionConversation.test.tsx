import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectSummary, SessionSummary, WorkspaceSummary } from "../../shared/types.js";
import type { ReviewState } from "../hooks/useReviewState.js";
import { SessionConversation } from "./SessionConversation.js";

function reviewStub(): ReviewState {
  return {
    files: [],
    filesState: "ready",
    filesError: null,
    selectedFilePath: null,
    diff: null,
    diffState: "idle",
    diffError: null,
    isPanelOpen: false,
    isSummaryCollapsed: true,
    mode: "changes",
    setMode: () => {},
    workspaceFiles: {
      entries: [],
      listState: "idle",
      listError: null,
      selectedPath: null,
      preview: null,
      previewState: "idle",
      previewError: null,
      openFile: () => {}
    },
    openFile: () => {},
    openPanelInFilesMode: () => {},
    closePanel: () => {},
    togglePanel: () => {},
    toggleSummary: () => {}
  };
}

function baseSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "session-a",
    workspaceId: "workspace-1",
    provider: "codex",
    modelLabel: "GPT-5.3 Codex",
    modelId: "gpt-5.3-codex",
    reasoningEffort: "medium",
    providerConversationId: null,
    prompt: "Build dashboard",
    state: "complete",
    attention: "normal",
    startedAt: "2026-05-12T15:30:00.000Z",
    completedAt: "2026-05-12T15:54:00.000Z",
    lastActivityAt: "2026-05-12T15:54:00.000Z",
    preferred: false,
    ...overrides
  };
}

const workspace: WorkspaceSummary = {
  id: "workspace-1",
  projectId: "project-1",
  taskLabel: "Build dashboard",
  branch: "argmax/dashboard",
  baseRef: "main",
  path: "/tmp/worktrees/dashboard",
  state: "running",
  sharedWorkspace: false,
  dirty: false,
  changedFiles: 0,
  lastActivityAt: "2026-05-12T15:54:00.000Z",
  pinned: false
};

const project: ProjectSummary = {
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
};

function renderConversation(session: SessionSummary) {
  return render(
    <SessionConversation
      events={[]}
      isLogOpen={false}
      onSendSessionInput={vi.fn().mockResolvedValue(undefined)}
      onTerminateSession={vi.fn().mockResolvedValue(undefined)}
      onCreateCheckpoint={vi.fn().mockResolvedValue(undefined)}
      onToggleLog={vi.fn()}
      project={project}
      rawOutputs={[]}
      review={reviewStub()}
      session={session}
      workspace={workspace}
    />
  );
}

describe("SessionConversation — model selection persistence", () => {
  afterEach(() => {
    cleanup();
  });

  it("does not reset the model picker when the session prop reference changes but id stays the same", () => {
    const v1 = baseSession({
      modelLabel: "GPT-5.3 Codex",
      modelId: "gpt-5.3-codex",
      reasoningEffort: "medium"
    });
    const { rerender } = renderConversation(v1);

    const picker = screen.getByRole("button", { name: "Session model" });
    expect(picker.textContent).toContain("GPT-5.3 Codex");
    expect(picker.textContent).toContain("Medium");

    // Parent rebuilds the SessionSummary object on every dashboard delta.
    // A new object reference with the same id (and even a freshly-emitted
    // server-side model swap) must NOT clobber the user's local pick.
    const v2 = baseSession({
      modelLabel: "Claude Haiku 4.5",
      modelId: "claude-haiku-4-5",
      reasoningEffort: undefined
    });
    rerender(
      <SessionConversation
        events={[]}
        isLogOpen={false}
        onSendSessionInput={vi.fn().mockResolvedValue(undefined)}
        onTerminateSession={vi.fn().mockResolvedValue(undefined)}
        onCreateCheckpoint={vi.fn().mockResolvedValue(undefined)}
        onToggleLog={vi.fn()}
        project={project}
        rawOutputs={[]}
        review={reviewStub()}
        session={v2}
        workspace={workspace}
      />
    );

    const pickerAfter = screen.getByRole("button", { name: "Session model" });
    expect(pickerAfter.textContent).toContain("GPT-5.3 Codex");
    expect(pickerAfter.textContent).toContain("Medium");
  });

  it("does reset the model picker when session.id changes (different session selected)", () => {
    const original = baseSession({
      id: "session-a",
      modelLabel: "GPT-5.3 Codex",
      modelId: "gpt-5.3-codex",
      reasoningEffort: "medium"
    });
    const { rerender } = renderConversation(original);
    expect(screen.getByRole("button", { name: "Session model" }).textContent).toContain("GPT-5.3 Codex");

    const switched = baseSession({
      id: "session-b",
      modelLabel: "Claude Haiku 4.5",
      modelId: "claude-haiku-4-5",
      reasoningEffort: undefined
    });
    rerender(
      <SessionConversation
        events={[]}
        isLogOpen={false}
        onSendSessionInput={vi.fn().mockResolvedValue(undefined)}
        onTerminateSession={vi.fn().mockResolvedValue(undefined)}
        onCreateCheckpoint={vi.fn().mockResolvedValue(undefined)}
        onToggleLog={vi.fn()}
        project={project}
        rawOutputs={[]}
        review={reviewStub()}
        session={switched}
        workspace={workspace}
      />
    );

    const pickerAfter = screen.getByRole("button", { name: "Session model" });
    expect(pickerAfter.textContent).toContain("Claude Haiku 4.5");
  });
});
