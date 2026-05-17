import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PendingMessage,
  ProjectSummary,
  SessionSummary,
  TimelineEvent,
  WorkspaceSummary
} from "../../shared/types.js";
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
      tabs: [],
      activeTabPath: null,
      selectedPath: null,
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
    permissionMode: "auto-approve",
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

function event(
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

function cursorAssistantPayload(text: string): Record<string, unknown> {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    session_id: "cursor-uuid-1",
    timestamp_ms: 1778771186474
  };
}

function renderConversation(
  session: SessionSummary,
  events: TimelineEvent[] = [],
  options: {
    pendingMessages?: PendingMessage[];
    onCancelQueuedMessage?: ReturnType<typeof vi.fn>;
    onOpenFile?: (path: string, opts?: { line?: number | null; preferIde?: boolean }) => void;
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
      {...(options.onOpenFile ? { onOpenFile: options.onOpenFile } : {})}
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

  it("keeps workspace context chips on the same toolbar row as the model picker", () => {
    renderConversation(baseSession());

    const modelPicker = screen.getByRole("button", { name: "Session model" });
    const workspaceContext = screen.getByLabelText("Workspace context");
    const toolbar = modelPicker.closest(".session-input-toolbar");

    expect(toolbar).not.toBeNull();
    expect(toolbar?.contains(workspaceContext)).toBe(true);
    expect(
      modelPicker.compareDocumentPosition(workspaceContext) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("renders repeated Cursor assistant snapshots once while streaming", () => {
    const text = "Reading the repo's key documentation and structure.";
    renderConversation(
      baseSession({ provider: "cursor", state: "running" }),
      [
        event("e2", "message.delta", text, "2026-05-12T15:00:01.000Z", cursorAssistantPayload(text)),
        event("e1", "message.delta", text, "2026-05-12T15:00:00.000Z", cursorAssistantPayload(text)),
        event("u1", "user.message", "summarize this repo", "2026-05-12T15:00:00.000Z")
      ]
    );

    expect(screen.getAllByText(text)).toHaveLength(1);
  });

  it("folds Codex command_execution singletons into the turn command group", () => {
    renderConversation(
      baseSession({ provider: "codex", state: "running" }),
      [
        event("u1", "user.message", "fix it", "2026-05-12T15:00:00.000Z"),
        event("cmd1-start", "command.started", "command_execution", "2026-05-12T15:00:01.000Z", {
          id: "cmd1",
          name: "command_execution",
          input: { command: "/bin/zsh -lc \"sed -n '1,120p' src/a.ts\"" }
        }),
        event("cmd1-end", "command.completed", "command_execution", "2026-05-12T15:00:02.000Z", {
          id: "cmd1",
          content: ""
        }),
        event("m1", "message.completed", "Checking the surrounding code.", "2026-05-12T15:00:03.000Z"),
        event("cmd2-start", "command.started", "command_execution", "2026-05-12T15:00:04.000Z", {
          id: "cmd2",
          name: "command_execution",
          input: { command: "/bin/zsh -lc \"rg -n useReviewState src\"" }
        }),
        event("cmd2-end", "command.completed", "command_execution", "2026-05-12T15:00:05.000Z", {
          id: "cmd2",
          content: ""
        }),
        event("cmd3-start", "command.started", "command_execution", "2026-05-12T15:00:06.000Z", {
          id: "cmd3",
          name: "command_execution",
          input: { command: "/bin/zsh -lc \"npm run lint\"" }
        }),
        event("cmd3-end", "command.completed", "command_execution", "2026-05-12T15:00:07.000Z", {
          id: "cmd3",
          content: ""
        })
      ]
    );

    fireEvent.click(screen.getByRole("button", { name: /Worked for/ }));

    expect(screen.getByRole("button", { name: /Ran 3 commands/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Ran 2 commands/ })).not.toBeInTheDocument();
  });

  it("renders a user.message bubble for an @-mention-only prompt while the session is still running", () => {
    renderConversation(
      baseSession({ state: "running" }),
      [event("u1", "user.message", "@AGENTS.md", "2026-05-12T15:00:00.000Z")]
    );

    const bubbleText = screen.getByText("@AGENTS.md", { selector: "p" });
    expect(bubbleText.closest(".chat-bubble.user")).not.toBeNull();
  });

  it("synthesizes a user bubble from session.prompt before the user.message event arrives", () => {
    renderConversation(baseSession({ state: "running", prompt: "@AGENTS.md" }), []);

    const bubbleText = screen.getByText("@AGENTS.md", { selector: "p" });
    expect(bubbleText.closest(".chat-bubble.user")).not.toBeNull();
  });

  it("does not duplicate the user bubble once the real user.message event arrives", () => {
    renderConversation(
      baseSession({ state: "running", prompt: "@AGENTS.md" }),
      [event("u1", "user.message", "@AGENTS.md", "2026-05-12T15:00:00.000Z")]
    );

    // Only the real event's bubble — the synth must drop out of renderItems.
    expect(screen.getAllByText("@AGENTS.md", { selector: "p" })).toHaveLength(1);
  });

  it("hides oversized-payload truncation markers from chat", () => {
    renderConversation(
      baseSession({ state: "complete" }),
      [
        event("e2", "error", "event payload truncated", "2026-05-12T15:00:01.000Z", {
          truncatedEventId: "truncated-1",
          originalSize: 70_000
        }),
        event("e1", "message.completed", "Done", "2026-05-12T15:00:00.000Z"),
        event("u1", "user.message", "summarize this repo", "2026-05-12T14:59:59.000Z")
      ]
    );

    expect(screen.queryByText("event payload truncated")).not.toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
  });

  it("keeps the composer enabled while the session is running so messages can be queued", () => {
    renderConversation(baseSession({ state: "running" }));

    const textarea = screen.getByLabelText("Session prompt");
    expect(textarea).toBeEnabled();
    // Stop button takes the mascot's slot while running; follow-ups queue via Enter.
    expect(screen.getByRole("button", { name: "Stop session" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Queue follow-up — sent when the current turn finishes" })
    ).not.toBeInTheDocument();
  });

  it("renders a chip per queued follow-up and cancels through the IPC callback", () => {
    const onCancel = vi.fn().mockResolvedValue(undefined);
    const queuedAt = "2026-05-12T15:30:30.000Z";
    const pending: PendingMessage[] = [
      {
        id: "queued-1",
        sessionId: "session-a",
        content: "add tests for the queue",
        agentMode: "edit",
        queuedAt
      },
      {
        id: "queued-2",
        sessionId: "session-a",
        content: "then run lint",
        agentMode: "edit",
        queuedAt
      }
    ];

    renderConversation(
      baseSession({ state: "running" }),
      [],
      { pendingMessages: pending, onCancelQueuedMessage: onCancel }
    );

    expect(screen.getByText("add tests for the queue")).toBeInTheDocument();
    expect(screen.getByText("then run lint")).toBeInTheDocument();

    const removeButtons = screen.getAllByRole("button", { name: "Cancel queued follow-up" });
    expect(removeButtons).toHaveLength(2);

    fireEvent.click(removeButtons[0]);
    expect(onCancel).toHaveBeenCalledWith("session-a", "queued-1");
  });

  it("routes a backticked file chip click to onOpenFile (right panel)", () => {
    const onOpenFile = vi.fn();
    renderConversation(
      baseSession({ state: "complete" }),
      [
        event(
          "m1",
          "message.completed",
          "See `src/foo.ts:42` for details.",
          "2026-05-12T15:00:00.000Z"
        )
      ],
      { onOpenFile }
    );

    fireEvent.click(screen.getByLabelText("Open src/foo.ts at line 42"));
    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(onOpenFile).toHaveBeenCalledWith("src/foo.ts", { line: 42, preferIde: false });
  });

  it("routes a markdown link to a local path through onOpenFile", () => {
    const onOpenFile = vi.fn();
    renderConversation(
      baseSession({ state: "complete" }),
      [
        event(
          "m1",
          "message.completed",
          "Open [foo](src/bar.ts) please.",
          "2026-05-12T15:00:00.000Z"
        )
      ],
      { onOpenFile }
    );

    fireEvent.click(screen.getByLabelText("Open src/bar.ts"));
    expect(onOpenFile).toHaveBeenCalledWith("src/bar.ts", { line: null, preferIde: false });
  });

  it("flags ⌘-click on a file chip with preferIde so the parent routes to the external IDE", () => {
    const onOpenFile = vi.fn();
    renderConversation(
      baseSession({ state: "complete" }),
      [
        event(
          "m1",
          "message.completed",
          "See `src/foo.ts` for details.",
          "2026-05-12T15:00:00.000Z"
        )
      ],
      { onOpenFile }
    );

    fireEvent.click(screen.getByLabelText("Open src/foo.ts"), { metaKey: true });
    expect(onOpenFile).toHaveBeenCalledWith("src/foo.ts", { line: null, preferIde: true });
  });

  it("leaves external markdown links as anchors (does not call onOpenFile)", () => {
    const onOpenFile = vi.fn();
    renderConversation(
      baseSession({ state: "complete" }),
      [
        event(
          "m1",
          "message.completed",
          "Docs at [example](https://example.com).",
          "2026-05-12T15:00:00.000Z"
        )
      ],
      { onOpenFile }
    );

    const link = screen.getByRole("link", { name: "example" });
    expect(link).toHaveAttribute("href", "https://example.com");
    fireEvent.click(link);
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("renders an assistant message produced in plan mode as a PlanCard", () => {
    const plan = [
      "# Plan: Tidy chat header",
      "",
      "Make the header lighter and clearer.",
      "",
      "## Key Changes",
      "",
      "- Update the badge color",
      "- Shrink the avatar"
    ].join("\n");

    renderConversation(baseSession({ state: "complete" }), [
      event("u1", "user.message", "draft a plan", "2026-05-12T15:00:00.000Z", { agentMode: "plan" }),
      event("m1", "message.completed", plan, "2026-05-12T15:00:01.000Z")
    ]);

    expect(screen.getByRole("article", { name: /Plan: Tidy chat header/ })).toBeInTheDocument();
    expect(screen.getByRole("listbox", { name: "Plan response" })).toBeInTheDocument();
    expect(screen.getByText("Key Changes")).toBeInTheDocument();
  });

  it("renders the same content as a ChatBubble when the turn was sent in edit mode", () => {
    const plan = [
      "# Plan: Tidy chat header",
      "",
      "Make the header lighter and clearer.",
      "",
      "## Key Changes",
      "",
      "- Update the badge color"
    ].join("\n");

    renderConversation(baseSession({ state: "complete" }), [
      event("u1", "user.message", "draft a plan", "2026-05-12T15:00:00.000Z", { agentMode: "edit" }),
      event("m1", "message.completed", plan, "2026-05-12T15:00:01.000Z")
    ]);

    expect(screen.queryByRole("listbox", { name: "Plan response" })).toBeNull();
    expect(screen.queryByRole("article", { name: /Plan: Tidy chat header/ })).toBeNull();
    // Title still shows, but as plain markdown inside a ChatBubble
    expect(screen.getByRole("heading", { name: "Plan: Tidy chat header" })).toBeInTheDocument();
  });

  it("falls back to a ChatBubble when a plan-mode reply has no parseable plan structure", () => {
    renderConversation(baseSession({ state: "complete" }), [
      event("u1", "user.message", "what time is it?", "2026-05-12T15:00:00.000Z", { agentMode: "plan" }),
      event("m1", "message.completed", "It's about 3:30 PM here.", "2026-05-12T15:00:01.000Z")
    ]);

    expect(screen.queryByRole("listbox", { name: "Plan response" })).toBeNull();
    expect(screen.getByText("It's about 3:30 PM here.")).toBeInTheDocument();
  });

  it("hides the per-session toolbar actions behind a Session actions picker", () => {
    renderConversation(baseSession({ state: "complete" }));

    // None of the consolidated actions are visible until the picker is opened.
    expect(screen.queryByRole("menuitem", { name: "Browse files" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Save checkpoint" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Git actions" })).toBeNull();
    expect(screen.queryByRole("menuitemcheckbox", { name: "Toggle debug log" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));

    expect(screen.getByRole("menuitem", { name: "Browse files" })).toBeInTheDocument();
    // The default workspace stub is clean, so the checkpoint row is disabled.
    expect(screen.getByRole("menuitem", { name: "Save checkpoint" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Git actions" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemcheckbox", { name: "Toggle debug log" })).toHaveAttribute(
      "aria-checked",
      "false"
    );
  });

  it("swaps the picker contents in place when Git actions is selected", () => {
    renderConversation(baseSession({ state: "complete" }));

    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Git actions" }));

    // Main menu items are no longer in the DOM; git actions take their place.
    expect(screen.queryByRole("menuitem", { name: "Browse files" })).toBeNull();
    expect(screen.queryByRole("menuitemcheckbox", { name: "Toggle debug log" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Push" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Create pull request|View pull request/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Create branch" })).toBeInTheDocument();

    // Back returns to the main menu.
    fireEvent.click(screen.getByRole("button", { name: "Back to session actions" }));
    expect(screen.getByRole("menuitem", { name: "Browse files" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Push" })).toBeNull();
  });
});
