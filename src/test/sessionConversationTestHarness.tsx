import { render, type RenderResult } from "@testing-library/react";
import type { JSX } from "react";
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
    changesScope: "branch",
    setChangesScope: () => {},
    availableScopes: ["branch", "committed", "uncommitted", "lastTurn"],
    comparisonBaseLabel: "main",
    subagents: {
      toolUseIds: [],
      activeToolUseId: null,
      selectTab: () => {},
      closeTab: () => {}
    },
    openAgent: () => {},
    openBrowser: () => {},
    browserOwner: false,
    browserRequest: null,
    workspaceFiles: {
      entries: [],
      listState: "idle",
      listError: null,
      refreshList: () => undefined,
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
    expandDiffContext: () => {},
    openChangesPanel: () => {},
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
    modelLabel: "GPT-5.6 Terra",
    modelId: "gpt-5.6-terra",
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
  kind: "git",
  dirty: false,
  changedFiles: 0,
  lastActivityAt: "2026-05-12T15:54:00.000Z",
  pinned: false,
  priorityDismissedAt: null,
  priorityAddedAt: null
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
    defaultModelId: "",
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

type ConversationProps = Parameters<typeof SessionConversation>[0];

type ConversationOptions = {
  defaultThinkingExpanded?: boolean;
  defaultToolCallsDisplay?: "expanded" | "collapsed" | "single-line";
  defaultToolCallGroupsExpanded?: boolean;
  pendingMessages?: PendingMessage[];
  // The conversation's own prop types, not `ReturnType<typeof vi.fn>`:
  // Vitest 4 types a bare `vi.fn()` as `Mock<Procedure | Constructable>`,
  // which no longer widens to a call signature, so a loose option type here
  // poisons every prop it feeds.
  onCancelQueuedMessage?: ConversationProps["onCancelQueuedMessage"];
  onSendQueuedMessageNow?: ConversationProps["onSendQueuedMessageNow"];
  onSendSessionInput?: ConversationProps["onSendSessionInput"];
  onTerminateSession?: ConversationProps["onTerminateSession"];
  onClearSession?: ConversationProps["onClearSession"];
  onNewSession?: ConversationProps["onNewSession"];
  onOpenFile?: (path: string, opts?: { line?: number | null; preferIde?: boolean }) => void;
  onOpenAgent?: (tool: ToolCall) => void;
  onOpenSideChat?: (seedPrompt: string) => Promise<void>;
  onOpenDetails?: (seedPrompt: string) => Promise<void>;
  registerAnnotationSink?: ConversationProps["registerAnnotationSink"];
  review?: ReviewState;
};

function conversationElement(
  session: SessionSummary,
  events: TimelineEvent[],
  options: ConversationOptions
): JSX.Element {
  return (
    <SessionConversation
      events={events}
      isLogOpen={false}
      onSendSessionInput={options.onSendSessionInput ?? vi.fn(() => Promise.resolve())}
      onTerminateSession={options.onTerminateSession ?? vi.fn(() => Promise.resolve())}
      onClearSession={options.onClearSession ?? vi.fn(() => Promise.resolve())}
      onCancelQueuedMessage={options.onCancelQueuedMessage ?? vi.fn(() => Promise.resolve())}
      onSendQueuedMessageNow={options.onSendQueuedMessageNow ?? vi.fn(() => Promise.resolve())}
      pendingMessages={options.pendingMessages ?? []}
      onToggleLog={vi.fn()}
      {...(options.defaultThinkingExpanded !== undefined ? { defaultThinkingExpanded: options.defaultThinkingExpanded } : {})}
      {...(options.defaultToolCallsDisplay !== undefined ? { defaultToolCallsDisplay: options.defaultToolCallsDisplay } : {})}
      {...(options.defaultToolCallGroupsExpanded !== undefined ? { defaultToolCallGroupsExpanded: options.defaultToolCallGroupsExpanded } : {})}
      {...(options.onNewSession ? { onNewSession: options.onNewSession } : {})}
      {...(options.onOpenFile ? { onOpenFile: options.onOpenFile } : {})}
      {...(options.onOpenAgent ? { onOpenAgent: options.onOpenAgent } : {})}
      {...(options.onOpenSideChat ? { onOpenSideChat: options.onOpenSideChat } : {})}
      {...(options.onOpenDetails ? { onOpenDetails: options.onOpenDetails } : {})}
      {...(options.registerAnnotationSink
        ? { registerAnnotationSink: options.registerAnnotationSink }
        : {})}
      project={project}
      rawOutputs={[]}
      review={options.review ?? reviewStub()}
      session={session}
      workspace={workspace}
    />
  );
}

export function renderConversation(
  session: SessionSummary,
  events: TimelineEvent[] = [],
  options: ConversationOptions = {}
) {
  return render(conversationElement(session, events, options));
}

/** Re-render the same pane with a changed session — the component keeps its
 *  state, which is the point when testing what survives a state transition. */
export function rerenderConversation(
  rerender: RenderResult["rerender"],
  session: SessionSummary,
  events: TimelineEvent[] = [],
  options: ConversationOptions = {}
): void {
  rerender(conversationElement(session, events, options));
}
