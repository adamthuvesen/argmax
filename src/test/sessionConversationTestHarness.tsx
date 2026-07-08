import { render } from "@testing-library/react";
import { vi } from "vitest";
import type {
  PendingMessage,
  ProjectSummary,
  SessionSummary,
  TimelineEvent,
  WorkspaceSummary
} from "../shared/types.js";
import type { ReviewState } from "../renderer/hooks/useReviewState.js";
import { SessionConversation } from "../renderer/components/SessionConversation.js";
import type { ToolCall } from "../renderer/lib/toolCalls.js";

export function reviewStub(overrides: Partial<ReviewState> = {}): ReviewState {
  return {
    files: [],
    filesState: "ready",
    filesError: null,
    selectedFilePath: null,
    diff: null,
    diffState: "idle",
    diffError: null,
    isPanelOpen: false,
    mode: "changes",
    setMode: () => {},
    changesComparison: "local",
    setChangesComparison: () => {},
    comparisonBaseLabel: "main",
    workspaceFiles: {
      entries: [],
      listState: "idle",
      listError: null,
      tabs: [],
      activeTabPath: null,
      selectedPath: null,
      rootPath: null,
      preview: null,
      previewState: "idle",
      previewError: null,
      openFile: () => {},
      selectTab: () => {},
      closeTab: () => {},
      dirtyClosePrompt: null,
      saveDirtyTabAndClose: () => Promise.resolve(),
      discardDirtyTabAndClose: () => {},
      cancelDirtyTabClose: () => {},
      buffer: null,
      isDirty: false,
      diskMtimeMs: null,
      externalChange: false,
      saveState: "idle",
      saveError: null,
      canEdit: true,
      editFile: () => {},
      saveFile: () => Promise.resolve(),
      reloadFile: () => {},
      dismissExternalChange: () => {}
    },
    openFile: () => {},
    openPanelInFilesMode: () => {},
    openInFilesView: () => {},
    closePanel: () => {},
    togglePanel: () => {},
    toggleChangesPanel: () => {},
    ...overrides
  };
}

export function baseSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "session-a",
    workspaceId: "workspace-1",
    provider: "codex",
    modelLabel: "GPT-5.3 Codex",
    modelId: "gpt-5.5",
    reasoningEffort: "medium",
    permissionMode: "auto-approve",
    providerConversationId: null,
    prompt: "Build dashboard",
    state: "complete",
    attention: "normal",
    startedAt: "2026-05-12T15:30:00.000Z",
    completedAt: "2026-05-12T15:54:00.000Z",
    lastActivityAt: "2026-05-12T15:54:00.000Z",
    ...overrides
  };
}

export const workspace: WorkspaceSummary = {
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

export const project: ProjectSummary = {
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

export function event(
  id: string,
  type: TimelineEvent["type"],
  message: string,
  createdAt: string,
  payload: Record<string, unknown> = {}
): TimelineEvent {
  return {
    id,
    sessionId: "session-a",
    type,
    message,
    payload,
    createdAt
  };
}

export function cursorAssistantPayload(text: string): Record<string, unknown> {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    session_id: "cursor-uuid-1",
    timestamp_ms: 1778771186474
  };
}

export function renderConversation(
  session: SessionSummary,
  events: TimelineEvent[] = [],
  options: {
    defaultThinkingExpanded?: boolean;
    defaultToolCallsExpanded?: boolean;
    defaultToolCallGroupsExpanded?: boolean;
    pendingMessages?: PendingMessage[];
    onCancelQueuedMessage?: ReturnType<typeof vi.fn>;
    onOpenFile?: (path: string, opts?: { line?: number | null; preferIde?: boolean }) => void;
    onOpenAgent?: (tool: ToolCall) => void;
    review?: ReviewState;
  } = {}
) {
  return render(
    <SessionConversation
      events={events}
      isLogOpen={false}
      onSendSessionInput={vi.fn().mockResolvedValue(undefined)}
      onTerminateSession={vi.fn().mockResolvedValue(undefined)}
      onCreateCheckpoint={vi.fn().mockResolvedValue(undefined)}
      onCancelQueuedMessage={options.onCancelQueuedMessage ?? vi.fn().mockResolvedValue(undefined)}
      pendingMessages={options.pendingMessages ?? []}
      onToggleLog={vi.fn()}
      {...(options.defaultThinkingExpanded !== undefined ? { defaultThinkingExpanded: options.defaultThinkingExpanded } : {})}
      {...(options.defaultToolCallsExpanded !== undefined ? { defaultToolCallsExpanded: options.defaultToolCallsExpanded } : {})}
      {...(options.defaultToolCallGroupsExpanded !== undefined ? { defaultToolCallGroupsExpanded: options.defaultToolCallGroupsExpanded } : {})}
      {...(options.onOpenFile ? { onOpenFile: options.onOpenFile } : {})}
      {...(options.onOpenAgent ? { onOpenAgent: options.onOpenAgent } : {})}
      project={project}
      rawOutputs={[]}
      review={options.review ?? reviewStub()}
      session={session}
      workspace={workspace}
    />
  );
}
