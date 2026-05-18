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
    toggleChangesPanel: () => {}
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

  it("renders exactly one streaming caret regardless of nested list depth", () => {
    const nestedMarkdown = [
      "Tasks:",
      "",
      "1. Use Glob to find all files",
      "2. For each file, note:",
      "   - Path",
      "   - Length",
      "   - Recently updated?",
      "3. Identify patterns:",
      "   - Sibling code",
      "   - Cross-references",
      "   - Orphans",
      "",
      "Return a structured list."
    ].join("\n");

    const { container } = renderConversation(
      baseSession({ state: "running" }),
      [
        event("u1", "user.message", "scan repo", "2026-05-12T15:00:00.000Z"),
        event("d1", "message.delta", nestedMarkdown, "2026-05-12T15:00:01.000Z")
      ]
    );

    expect(container.querySelectorAll(".streaming-caret")).toHaveLength(1);
    expect(container.querySelector(".markdown-streaming .streaming-caret")).not.toBeNull();
  });

  it("removes the streaming caret once the assistant message completes", () => {
    const text = "1. First\n2. Second";

    const { container } = renderConversation(
      baseSession({ state: "complete" }),
      [
        event("u1", "user.message", "go", "2026-05-12T15:00:00.000Z"),
        event("m1", "message.completed", text, "2026-05-12T15:00:01.000Z")
      ]
    );

    expect(container.querySelectorAll(".streaming-caret")).toHaveLength(0);
    expect(container.querySelector(".markdown-streaming")).toBeNull();
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

  it("hides legacy sub-agent prompt echoes tagged with parent_tool_use_id", () => {
    renderConversation(
      baseSession({ provider: "claude", state: "running" }),
      [
        event("u1", "user.message", "make a plan", "2026-05-12T15:00:00.000Z"),
        event("tu-task", "command.started", "Agent", "2026-05-12T15:00:01.000Z", {
          type: "tool_use",
          id: "toolu_parent_task",
          name: "Agent",
          input: {
            subagent_type: "Explore",
            description: "Map documentation structure and identify gaps",
            prompt: "Explore the documentation in this Electron/React Argmax project."
          }
        }),
        event(
          "m-subagent-prompt",
          "message.delta",
          "Explore the documentation in this Electron/React Argmax project.",
          "2026-05-12T15:00:02.000Z",
          {
            type: "user",
            parent_tool_use_id: "toolu_parent_task",
            subagent_type: "Explore"
          }
        )
      ]
    );

    expect(screen.getByLabelText("Agent Map documentation structure and identify gaps")).toBeInTheDocument();
    expect(screen.queryByText("Explore the documentation in this Electron/React Argmax project.")).not.toBeInTheDocument();
  });

  it("hides assistant text emitted AFTER an ExitPlanMode card so the plan isn't duplicated as a chat bubble", () => {
    // When Argmax denies ExitPlanMode in structured-json mode, the model
    // often retries by writing the plan as a text fallback. The card has
    // already rendered, so showing the fallback text below it duplicates
    // the entire plan in the chat. Pre-tool narration stays visible
    // because it's useful intro context.
    renderConversation(
      baseSession({ provider: "claude", state: "complete" }),
      [
        event("u1", "user.message", "make a plan", "2026-05-12T15:00:00.000Z", {
          agentMode: "plan"
        }),
        event("m1", "message.completed", "Let me draft a plan.", "2026-05-12T15:00:01.000Z"),
        event("tu-start", "command.started", "ExitPlanMode", "2026-05-12T15:00:02.000Z", {
          type: "tool_use",
          id: "tu_plan_dup",
          name: "ExitPlanMode",
          input: { plan: "## Plan\n\n**Step:** Do the thing\n\nApprove?" }
        }),
        event("tu-end", "command.completed", "tool_result", "2026-05-12T15:00:03.000Z", {
          tool_use_id: "tu_plan_dup",
          content: "Exit plan mode?",
          is_error: true
        }),
        event("m2", "message.completed", "Plan written. Ready for your approval.", "2026-05-12T15:00:04.000Z")
      ]
    );

    expect(screen.getByLabelText(/Plan: /)).toBeInTheDocument();
    // Pre-tool intro narration is kept.
    expect(screen.getByText("Let me draft a plan.")).toBeInTheDocument();
    // Post-tool fallback text is suppressed (the card already conveys it).
    expect(screen.queryByText("Plan written. Ready for your approval.")).not.toBeInTheDocument();
  });

  it("renders a PlanCard from ExitPlanMode even when the tool ended in error (denied in structured-json mode)", () => {
    // In structured-json mode Argmax denies ExitPlanMode with a tool_result
    // {is_error: true, content: "Exit plan mode?"}. The plan markdown is
    // still in inputFull.plan, so the card MUST still render — otherwise the
    // user just sees a "Plan written" text bubble with no card.
    const planMarkdown =
      "## Refactor docs\n\n**Files to change:** README.md, agents/docs/\n\nApprove?";
    renderConversation(
      baseSession({ provider: "claude", state: "complete" }),
      [
        event("u1", "user.message", "make a plan", "2026-05-12T15:00:00.000Z", {
          agentMode: "plan"
        }),
        event("tu-start", "command.started", "ExitPlanMode", "2026-05-12T15:00:01.000Z", {
          type: "tool_use",
          id: "tu_plan_err",
          name: "ExitPlanMode",
          input: { plan: planMarkdown }
        }),
        event("tu-end", "command.completed", "tool_result", "2026-05-12T15:00:02.000Z", {
          tool_use_id: "tu_plan_err",
          content: "Exit plan mode?",
          is_error: true
        })
      ]
    );

    expect(screen.getByLabelText(/Plan: /)).toBeInTheDocument();
    expect(screen.getByText("Refactor docs")).toBeInTheDocument();
    expect(screen.queryByText("ExitPlanMode")).not.toBeInTheDocument();
  });

  it("renders an ExitPlanMode tool call as a PlanCard, hiding the raw tool row", () => {
    const planMarkdown =
      "## Refactor auth module\n\n" +
      "**Files to change:** auth.ts, login.tsx\n\n" +
      "Approve this plan?";
    renderConversation(
      baseSession({ provider: "claude", state: "complete" }),
      [
        event("u1", "user.message", "refactor auth", "2026-05-12T15:00:00.000Z", {
          agentMode: "plan"
        }),
        event(
          "m1",
          "message.completed",
          "Let me lay out a plan.",
          "2026-05-12T15:00:01.000Z"
        ),
        event("tu-start", "command.started", "ExitPlanMode", "2026-05-12T15:00:02.000Z", {
          type: "tool_use",
          id: "tu_plan_1",
          name: "ExitPlanMode",
          input: { plan: planMarkdown }
        }),
        event("tu-end", "command.completed", "tool_result", "2026-05-12T15:00:03.000Z", {
          tool_use_id: "tu_plan_1",
          content: "ok"
        })
      ]
    );

    expect(screen.getByLabelText(/Plan: /)).toBeInTheDocument();
    expect(screen.getByText("Refactor auth module")).toBeInTheDocument();
    expect(screen.getByText("Let me lay out a plan.")).toBeInTheDocument();
    // The raw ExitPlanMode tool row should not appear once the card has the plan.
    expect(screen.queryByText("ExitPlanMode")).not.toBeInTheDocument();
  });

  it("renders a failed AskUserQuestion tool call as a QuestionCard and submits the chosen answer", () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(
      <SessionConversation
        events={[
          event("u1", "user.message", "what should we do", "2026-05-12T15:00:00.000Z", {
            agentMode: "plan"
          }),
          event("tu-start", "command.started", "AskUserQuestion", "2026-05-12T15:00:01.000Z", {
            type: "tool_use",
            id: "tu_q_1",
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "Pick a direction",
                  header: "Direction",
                  multiSelect: false,
                  options: [
                    { label: "Fix audit findings", description: "Address 4 high-severity bugs" },
                    { label: "General maintenance", description: "Clean up timestamps" }
                  ]
                }
              ]
            }
          }),
          event("tu-end", "command.completed", "tool_result", "2026-05-12T15:00:02.000Z", {
            tool_use_id: "tu_q_1",
            content: "Answer questions?",
            is_error: true
          })
        ]}
        isLogOpen={false}
        onSendSessionInput={onSend}
        onTerminateSession={vi.fn().mockResolvedValue(undefined)}
        onCreateCheckpoint={vi.fn().mockResolvedValue(undefined)}
        onCancelQueuedMessage={vi.fn().mockResolvedValue(undefined)}
        pendingMessages={[]}
        onToggleLog={vi.fn()}
        project={project}
        rawOutputs={[]}
        review={reviewStub()}
        session={baseSession({ provider: "claude", state: "complete" })}
        workspace={workspace}
      />
    );

    expect(screen.getByLabelText("Question from agent")).toBeInTheDocument();
    expect(screen.getByText("Pick a direction")).toBeInTheDocument();
    // Tool row is hidden once the card renders.
    expect(screen.queryByText("AskUserQuestion")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("option", { name: /Fix audit findings/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));

    expect(onSend).toHaveBeenCalledTimes(1);
    const call = onSend.mock.calls[0] as [string, string, unknown, string] | undefined;
    expect(call?.[1]).toContain("**Direction**: Fix audit findings");
    expect(call?.[3]).toBe("plan");
  });

  it("terminates the in-flight probe before sending the QuestionCard answer (no queue wait)", async () => {
    // While Haiku is still emitting fallback narration after a denied
    // AskUserQuestion, session.state === "running". A naive send would queue
    // the answer behind that narration. Instead we terminate first, then
    // send — main's sendInput relaunches the agent on the next message.
    const onSend = vi.fn().mockResolvedValue(undefined);
    const onTerminate = vi.fn().mockResolvedValue(undefined);
    render(
      <SessionConversation
        events={[
          event("u1", "user.message", "ask me", "2026-05-12T15:00:00.000Z", {
            agentMode: "plan"
          }),
          event("tu-start", "command.started", "AskUserQuestion", "2026-05-12T15:00:01.000Z", {
            type: "tool_use",
            id: "tu_q_running",
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "Pick",
                  header: "Pick",
                  multiSelect: false,
                  options: [{ label: "A" }, { label: "B" }]
                }
              ]
            }
          }),
          event("tu-end", "command.completed", "tool_result", "2026-05-12T15:00:02.000Z", {
            tool_use_id: "tu_q_running",
            content: "Answer questions?",
            is_error: true
          })
        ]}
        isLogOpen={false}
        onSendSessionInput={onSend}
        onTerminateSession={onTerminate}
        onCreateCheckpoint={vi.fn().mockResolvedValue(undefined)}
        onCancelQueuedMessage={vi.fn().mockResolvedValue(undefined)}
        pendingMessages={[]}
        onToggleLog={vi.fn()}
        project={project}
        rawOutputs={[]}
        review={reviewStub()}
        session={baseSession({ provider: "claude", state: "running" })}
        workspace={workspace}
      />
    );

    fireEvent.click(screen.getByRole("option", { name: /A/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));

    expect(onTerminate).toHaveBeenCalledWith("session-a");
    // Send fires AFTER terminate resolves.
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    const terminateOrder = onTerminate.mock.invocationCallOrder[0];
    const sendOrder = onSend.mock.invocationCallOrder[0];
    expect(terminateOrder).toBeLessThan(sendOrder);
  });

  it("shows the Thinking indicator between events while the session is still running", () => {
    // After `message.completed` (or `command.completed`) while the session
    // is still running, the model is mid-turn — deciding what to do next.
    // Before the next event arrives there's no streaming caret or tool
    // spinner on screen, so the chat would otherwise sit silent. Thinking
    // should fill the gap.
    renderConversation(
      baseSession({ provider: "claude", state: "running" }),
      [
        event("u1", "user.message", "do a thing", "2026-05-12T15:00:00.000Z"),
        event("m1", "message.completed", "Working on it.", "2026-05-12T15:00:01.000Z")
      ]
    );

    expect(screen.getByLabelText("Thinking")).toBeInTheDocument();
  });

  it("suppresses the Thinking indicator while AskUserQuestion is outstanding (the card is the ask)", () => {
    // When AskUserQuestion has fired and no user.message has landed since,
    // the agent is waiting on the user — even though the probe may still
    // technically be running while it emits fallback text. The Thinking
    // bubble would mislead the user into thinking the agent is still
    // working. The card itself conveys "waiting for you".
    renderConversation(
      baseSession({ provider: "claude", state: "running" }),
      [
        event("u1", "user.message", "ask me", "2026-05-12T15:00:00.000Z", {
          agentMode: "plan"
        }),
        event("tu-start", "command.started", "AskUserQuestion", "2026-05-12T15:00:01.000Z", {
          type: "tool_use",
          id: "tu_q_running",
          name: "AskUserQuestion",
          input: { questions: [{ question: "?", header: "?", multiSelect: false, options: [{ label: "A" }] }] }
        })
        // No command.completed yet — tool still running.
      ]
    );

    expect(screen.queryByLabelText("Thinking")).not.toBeInTheDocument();
  });

  it("restores Thinking once the user submits and a new user.message arrives", () => {
    // After the user submits the card, a new user.message lands.
    // `lastUserMessageTime` now advances past the AskUserQuestion's
    // createdAt, so the outstanding-ask gate releases and Thinking is
    // free to indicate that the next turn is being processed.
    renderConversation(
      baseSession({ provider: "claude", state: "running" }),
      [
        event("u1", "user.message", "ask me", "2026-05-12T15:00:00.000Z", {
          agentMode: "plan"
        }),
        event("tu-start", "command.started", "AskUserQuestion", "2026-05-12T15:00:01.000Z", {
          type: "tool_use",
          id: "tu_q_done",
          name: "AskUserQuestion",
          input: { questions: [{ question: "?", header: "?", multiSelect: false, options: [{ label: "A" }] }] }
        }),
        event("tu-end", "command.completed", "tool_result", "2026-05-12T15:00:02.000Z", {
          tool_use_id: "tu_q_done",
          content: "Answer questions?",
          is_error: true
        }),
        event("u2", "user.message", "**Question**: A", "2026-05-12T15:00:03.000Z")
      ]
    );

    expect(screen.getByLabelText("Thinking")).toBeInTheDocument();
  });

  it("hides the Thinking indicator while a regular tool is actually running on screen", () => {
    // For a visible tool, the row's own spinner is the progress indicator —
    // no need to double up with Thinking.
    renderConversation(
      baseSession({ provider: "claude", state: "running" }),
      [
        event("u1", "user.message", "run it", "2026-05-12T15:00:00.000Z"),
        event("tu-start", "command.started", "Bash", "2026-05-12T15:00:01.000Z", {
          type: "tool_use",
          id: "tu_bash_running",
          name: "Bash",
          input: { command: "ls" }
        })
      ]
    );

    expect(screen.queryByLabelText("Thinking")).not.toBeInTheDocument();
  });

  it("renders an AskUserQuestion card immediately from command.started and hides the raw row", () => {
    // In parallel-tool turns, Claude can start AskUserQuestion and keep the
    // provider process busy with a sub-agent for many seconds before the
    // tool_result/error arrives. The card can render from the complete
    // command.started input; waiting for completion hides the actual ask.
    render(
      <SessionConversation
        events={[
          event("u1", "user.message", "decide", "2026-05-12T15:00:00.000Z", {
            agentMode: "plan"
          }),
          event("tu-start", "command.started", "AskUserQuestion", "2026-05-12T15:00:01.000Z", {
            type: "tool_use",
            id: "tu_q_running",
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "Pick",
                  header: "Pick",
                  multiSelect: false,
                  options: [{ label: "A" }, { label: "B" }]
                }
              ]
            }
          })
          // No `command.completed` event yet — the tool is still running.
        ]}
        isLogOpen={false}
        onSendSessionInput={vi.fn().mockResolvedValue(undefined)}
        onTerminateSession={vi.fn().mockResolvedValue(undefined)}
        onCreateCheckpoint={vi.fn().mockResolvedValue(undefined)}
        onCancelQueuedMessage={vi.fn().mockResolvedValue(undefined)}
        pendingMessages={[]}
        onToggleLog={vi.fn()}
        project={project}
        rawOutputs={[]}
        review={reviewStub()}
        session={baseSession({ provider: "claude", state: "running" })}
        workspace={workspace}
      />
    );

    // Tool row hidden from the moment it fires.
    expect(screen.queryByText("AskUserQuestion")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Question from agent")).toBeInTheDocument();
    expect(screen.getByText("Pick")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Working/ })).not.toBeInTheDocument();
  });

  it("keeps useful assistant fallback text after an AskUserQuestion card", () => {
    renderConversation(
      baseSession({ provider: "claude", state: "complete" }),
      [
        event("u1", "user.message", "scan and ask", "2026-05-12T15:00:00.000Z", {
          agentMode: "plan"
        }),
        event("tu-start", "command.started", "AskUserQuestion", "2026-05-12T15:00:01.000Z", {
          type: "tool_use",
          id: "tu_q_fallback",
          name: "AskUserQuestion",
          input: {
            questions: [
              {
                question: "What should we prioritize?",
                header: "Priority",
                multiSelect: false,
                options: [{ label: "Runbooks" }, { label: "Examples" }]
              }
            ]
          }
        }),
        event("tu-end", "command.completed", "tool_result", "2026-05-12T15:00:02.000Z", {
          tool_use_id: "tu_q_fallback",
          content: "Answer questions?",
          is_error: true
        }),
        event(
          "m1",
          "message.completed",
          "The docs scan found thin release notes. What should we prioritize?",
          "2026-05-12T15:00:08.000Z"
        )
      ]
    );

    expect(screen.getByLabelText("Question from agent")).toBeInTheDocument();
    expect(screen.getByText("The docs scan found thin release notes. What should we prioritize?")).toBeInTheDocument();
  });

  it("hides invalid running AskUserQuestion attempts and renders the first valid retry", () => {
    render(
      <SessionConversation
        events={[
          event("u1", "user.message", "decide", "2026-05-12T15:00:00.000Z", {
            agentMode: "plan"
          }),
          event("bad-start", "command.started", "AskUserQuestion", "2026-05-12T15:00:01.000Z", {
            type: "tool_use",
            id: "tu_q_bad",
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "Too many options",
                  header: "Bad",
                  multiSelect: false,
                  options: [
                    { label: "A" },
                    { label: "B" },
                    { label: "C" },
                    { label: "D" },
                    { label: "E" }
                  ]
                }
              ]
            }
          }),
          event("good-start", "command.started", "AskUserQuestion", "2026-05-12T15:00:02.000Z", {
            type: "tool_use",
            id: "tu_q_good",
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "Valid retry",
                  header: "Good",
                  multiSelect: false,
                  options: [{ label: "A" }, { label: "B" }]
                }
              ]
            }
          })
        ]}
        isLogOpen={false}
        onSendSessionInput={vi.fn().mockResolvedValue(undefined)}
        onTerminateSession={vi.fn().mockResolvedValue(undefined)}
        onCreateCheckpoint={vi.fn().mockResolvedValue(undefined)}
        onCancelQueuedMessage={vi.fn().mockResolvedValue(undefined)}
        pendingMessages={[]}
        onToggleLog={vi.fn()}
        project={project}
        rawOutputs={[]}
        review={reviewStub()}
        session={baseSession({ provider: "claude", state: "running" })}
        workspace={workspace}
      />
    );

    expect(screen.getByLabelText("Question from agent")).toBeInTheDocument();
    expect(screen.getByText("Valid retry")).toBeInTheDocument();
    expect(screen.queryByText("Too many options")).not.toBeInTheDocument();
    expect(screen.queryByText("AskUserQuestion")).not.toBeInTheDocument();
  });

  it("renders a running AskUserQuestion card when it is mixed into an active tool group", () => {
    render(
      <SessionConversation
        events={[
          event("u1", "user.message", "scan and ask", "2026-05-12T15:00:00.000Z", {
            agentMode: "plan"
          }),
          event("agent-start", "command.started", "Agent", "2026-05-12T15:00:01.000Z", {
            type: "tool_use",
            id: "tu_agent",
            name: "Agent",
            input: {
              description: "Explore docs",
              subagent_type: "Explore",
              prompt: "Map docs"
            }
          }),
          event("ask-start", "command.started", "AskUserQuestion", "2026-05-12T15:00:01.020Z", {
            type: "tool_use",
            id: "tu_q_parallel",
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "What should we prioritize?",
                  header: "Priority",
                  multiSelect: false,
                  options: [{ label: "Runbooks" }, { label: "Examples" }]
                }
              ]
            }
          }),
          event("bash-start", "command.started", "Bash", "2026-05-12T15:00:01.040Z", {
            type: "tool_use",
            id: "tu_bash",
            name: "Bash",
            input: { command: "echo ok" }
          })
        ]}
        isLogOpen={false}
        onSendSessionInput={vi.fn().mockResolvedValue(undefined)}
        onTerminateSession={vi.fn().mockResolvedValue(undefined)}
        onCreateCheckpoint={vi.fn().mockResolvedValue(undefined)}
        onCancelQueuedMessage={vi.fn().mockResolvedValue(undefined)}
        pendingMessages={[]}
        onToggleLog={vi.fn()}
        project={project}
        rawOutputs={[]}
        review={reviewStub()}
        session={baseSession({ provider: "claude", state: "running" })}
        workspace={workspace}
      />
    );

    expect(screen.getByLabelText("Question from agent")).toBeInTheDocument();
    expect(screen.getByText("What should we prioritize?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Spawned 1 agent/ }));
    expect(screen.getByRole("button", { name: "Agent Explore docs" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ran echo ok" })).toBeInTheDocument();
    expect(screen.queryByText("AskUserQuestion")).not.toBeInTheDocument();
  });

  it("hides the ExitPlanMode tool row immediately, even while still running (no flicker)", () => {
    render(
      <SessionConversation
        events={[
          event("u1", "user.message", "plan it", "2026-05-12T15:00:00.000Z", {
            agentMode: "plan"
          }),
          event("tu-start", "command.started", "ExitPlanMode", "2026-05-12T15:00:01.000Z", {
            type: "tool_use",
            id: "tu_plan_running",
            name: "ExitPlanMode",
            input: { plan: "## Title\n\n**Section:** body\n\nApprove?" }
          })
        ]}
        isLogOpen={false}
        onSendSessionInput={vi.fn().mockResolvedValue(undefined)}
        onTerminateSession={vi.fn().mockResolvedValue(undefined)}
        onCreateCheckpoint={vi.fn().mockResolvedValue(undefined)}
        onCancelQueuedMessage={vi.fn().mockResolvedValue(undefined)}
        pendingMessages={[]}
        onToggleLog={vi.fn()}
        project={project}
        rawOutputs={[]}
        review={reviewStub()}
        session={baseSession({ provider: "claude", state: "running" })}
        workspace={workspace}
      />
    );

    expect(screen.queryByText("ExitPlanMode")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Plan: /)).not.toBeInTheDocument();
  });

  it("renders an ExitPlanMode card when the tool is folded into a mixed tool group", () => {
    render(
      <SessionConversation
        defaultToolCallsExpanded={true}
        events={[
          event("u1", "user.message", "plan and check", "2026-05-12T15:00:00.000Z", {
            agentMode: "plan"
          }),
          event("plan-start", "command.started", "ExitPlanMode", "2026-05-12T15:00:01.000Z", {
            type: "tool_use",
            id: "tu_plan_grouped",
            name: "ExitPlanMode",
            input: { plan: "## Grouped plan\n\n**Step:** Keep the bash row visible\n\nApprove?" }
          }),
          event("bash-start", "command.started", "Bash", "2026-05-12T15:00:01.020Z", {
            type: "tool_use",
            id: "tu_bash_grouped",
            name: "Bash",
            input: { command: "echo ok" }
          }),
          event("plan-end", "command.completed", "tool_result", "2026-05-12T15:00:01.040Z", {
            tool_use_id: "tu_plan_grouped",
            content: "ok"
          }),
          event("bash-end", "command.completed", "tool_result", "2026-05-12T15:00:01.060Z", {
            tool_use_id: "tu_bash_grouped",
            content: "ok"
          })
        ]}
        isLogOpen={false}
        onSendSessionInput={vi.fn().mockResolvedValue(undefined)}
        onTerminateSession={vi.fn().mockResolvedValue(undefined)}
        onCreateCheckpoint={vi.fn().mockResolvedValue(undefined)}
        onCancelQueuedMessage={vi.fn().mockResolvedValue(undefined)}
        pendingMessages={[]}
        onToggleLog={vi.fn()}
        project={project}
        rawOutputs={[]}
        review={reviewStub()}
        session={baseSession({ provider: "claude", state: "complete" })}
        workspace={workspace}
      />
    );

    expect(screen.getByLabelText(/Plan: /)).toBeInTheDocument();
    expect(screen.getByText("Grouped plan")).toBeInTheDocument();
    expect(screen.queryByText("ExitPlanMode")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ran echo ok" })).toBeInTheDocument();
  });

  it("still renders the QuestionCard when AskUserQuestion retries fold into a tool-group", () => {
    // Two AskUserQuestion calls within the 75ms parallel-window fold into
    // a `tool-group`. Detection that only checks `t.kind === "tool"` would
    // silently miss this case and the card would vanish after a brief flash.
    render(
      <SessionConversation
        events={[
          event("u1", "user.message", "what should we do", "2026-05-12T15:00:00.000Z", {
            agentMode: "plan"
          }),
          event("tu1-start", "command.started", "AskUserQuestion", "2026-05-12T15:00:01.000Z", {
            type: "tool_use",
            id: "tu_q_a",
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "First attempt",
                  header: "First",
                  multiSelect: false,
                  options: [{ label: "Option A" }, { label: "Option B" }]
                }
              ]
            }
          }),
          event("tu1-end", "command.completed", "tool_result", "2026-05-12T15:00:01.020Z", {
            tool_use_id: "tu_q_a",
            content: "Answer questions?",
            is_error: true
          }),
          event("tu2-start", "command.started", "AskUserQuestion", "2026-05-12T15:00:01.040Z", {
            type: "tool_use",
            id: "tu_q_b",
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "Refined ask — what's the priority?",
                  header: "Priority",
                  multiSelect: false,
                  options: [{ label: "Fix bugs" }, { label: "Add features" }]
                }
              ]
            }
          }),
          event("tu2-end", "command.completed", "tool_result", "2026-05-12T15:00:01.060Z", {
            tool_use_id: "tu_q_b",
            content: "Answer questions?",
            is_error: true
          })
        ]}
        isLogOpen={false}
        onSendSessionInput={vi.fn().mockResolvedValue(undefined)}
        onTerminateSession={vi.fn().mockResolvedValue(undefined)}
        onCreateCheckpoint={vi.fn().mockResolvedValue(undefined)}
        onCancelQueuedMessage={vi.fn().mockResolvedValue(undefined)}
        pendingMessages={[]}
        onToggleLog={vi.fn()}
        project={project}
        rawOutputs={[]}
        review={reviewStub()}
        session={baseSession({ provider: "claude", state: "complete" })}
        workspace={workspace}
      />
    );

    expect(screen.getByLabelText("Question from agent")).toBeInTheDocument();
    // First valid attempt wins and stays put — swapping to the retry would
    // remount the card and wipe in-progress selections.
    expect(screen.getByText("First attempt")).toBeInTheDocument();
    expect(screen.queryByText(/Refined ask/)).not.toBeInTheDocument();
    // The fold-induced tool-group row is suppressed.
    expect(screen.queryByRole("button", { name: /Ran 2 commands/ })).not.toBeInTheDocument();
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
        agentMode: "auto",
        queuedAt
      },
      {
        id: "queued-2",
        sessionId: "session-a",
        content: "then run lint",
        agentMode: "auto",
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

  it("queued chips are keyboard-focusable and Backspace/Delete cancels them", () => {
    const onCancel = vi.fn().mockResolvedValue(undefined);
    const queuedAt = "2026-05-12T15:30:30.000Z";
    const pending: PendingMessage[] = [
      { id: "queued-1", sessionId: "session-a", content: "first", agentMode: "auto", queuedAt },
      { id: "queued-2", sessionId: "session-a", content: "second", agentMode: "auto", queuedAt }
    ];

    renderConversation(
      baseSession({ state: "running" }),
      [],
      { pendingMessages: pending, onCancelQueuedMessage: onCancel }
    );

    const firstChip = screen.getByLabelText("Queued follow-up: first");
    const secondChip = screen.getByLabelText("Queued follow-up: second");
    expect(firstChip).toHaveAttribute("tabindex", "0");
    expect(secondChip).toHaveAttribute("tabindex", "0");

    firstChip.focus();
    fireEvent.keyDown(firstChip, { key: "Backspace" });
    expect(onCancel).toHaveBeenCalledWith("session-a", "queued-1");

    secondChip.focus();
    fireEvent.keyDown(secondChip, { key: "Delete" });
    expect(onCancel).toHaveBeenCalledWith("session-a", "queued-2");
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
      event("u1", "user.message", "draft a plan", "2026-05-12T15:00:00.000Z", { agentMode: "auto" }),
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
