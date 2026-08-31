import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { attachmentProtocolUrl } from "../../shared/attachmentProtocol.js";
import type { PendingMessage, RawProviderOutput, TimelineEvent } from "../../shared/types.js";
import { SessionConversation } from "./SessionConversation.js";
import { THINKING_WORDS } from "./ThinkingLabel.js";
import { startedAgentName } from "../../test/agentRowName.js";
import {
  baseSession,
  cursorAssistantPayload,
  event,
  project,
  renderConversation,
  reviewStub,
  workspace
} from "../../test/sessionConversationTestHarness.js";

describe("SessionConversation — streaming & composer", () => {
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });
  it("hangs the restore flag on the scroller so a reopened transcript does not replay its entrance animations", async () => {
    // The class and the attribute are the CSS contract itself
    // (chat-conversation.css zeroes the entrance animations under
    // `[data-restoring="true"]`), so this asserts them directly.
    const { container } = renderConversation(baseSession());
    const scroller = container.querySelector(".conversation-scroll");

    expect(scroller?.getAttribute("data-restoring")).toBe("true");
    await waitFor(() => expect(scroller?.getAttribute("data-restoring")).toBeNull());
  });

  it("does not reset the model picker when the session prop reference changes but id stays the same", () => {
    const v1 = baseSession({
      modelLabel: "GPT-5.6 Terra",
      modelId: "gpt-5.6-terra",
      reasoningEffort: "medium"
    });
    const { rerender } = renderConversation(v1);

    const picker = screen.getByRole("button", { name: "Session model" });
    expect(picker.textContent).toContain("GPT-5.6 Terra");
    // Effort rides in its own chip beside the model, not in the model label.
    expect(screen.getByRole("button", { name: "Session model effort" }).textContent).toContain("Medium");

    // Parent rebuilds the SessionSummary object on every dashboard delta.
    // A new object reference with the same id (and even a freshly-emitted
    // server-side model swap) must NOT clobber the user's local pick.
    const v2 = baseSession({
      modelLabel: "Haiku 4.5",
      modelId: "claude-haiku-4-5",
      reasoningEffort: undefined
    });
    rerender(
      <SessionConversation
        events={[]}
        isLogOpen={false}
        onSendSessionInput={vi.fn().mockResolvedValue(undefined)}
        onTerminateSession={vi.fn().mockResolvedValue(undefined)}
        onToggleLog={vi.fn()}
        project={project}
        rawOutputs={[]}
        review={reviewStub()}
        session={v2}
        workspace={workspace}
      />
    );

    const pickerAfter = screen.getByRole("button", { name: "Session model" });
    expect(pickerAfter.textContent).toContain("GPT-5.6 Terra");
    expect(screen.getByRole("button", { name: "Session model effort" }).textContent).toContain("Medium");
  });

  it("does reset the model picker when session.id changes (different session selected)", () => {
    const original = baseSession({
      id: "session-a",
      modelLabel: "GPT-5.6 Terra",
      modelId: "gpt-5.6-terra",
      reasoningEffort: "medium"
    });
    const { rerender } = renderConversation(original);
    expect(screen.getByRole("button", { name: "Session model" }).textContent).toContain("GPT-5.6 Terra");

    const switched = baseSession({
      id: "session-b",
      provider: "claude",
      modelLabel: "Haiku 4.5",
      modelId: "claude-haiku-4-5",
      reasoningEffort: undefined
    });
    rerender(
      <SessionConversation
        events={[]}
        isLogOpen={false}
        onSendSessionInput={vi.fn().mockResolvedValue(undefined)}
        onTerminateSession={vi.fn().mockResolvedValue(undefined)}
        onToggleLog={vi.fn()}
        project={project}
        rawOutputs={[]}
        review={reviewStub()}
        session={switched}
        workspace={workspace}
      />
    );

    const pickerAfter = screen.getByRole("button", { name: "Session model" });
    expect(pickerAfter.textContent).toContain("Haiku 4.5");
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

  it("marks the branch chip label as ellipsis-safe and leaves it out of the tab order", () => {
    renderConversation(baseSession());

    // A label, not a control — it must not be reachable as a button.
    expect(screen.queryByRole("button", { name: /^Branch / })).toBeNull();
    const branchChip = screen.getByTitle("Branch: argmax/dashboard");
    expect(branchChip).toHaveClass("composer-footer-chip--branch");
    expect(branchChip.querySelector(".composer-footer-chip-label")).toHaveTextContent(
      "argmax/dashboard"
    );
  });

  it("shows changed-file totals as a compact composer action and opens the review panel", () => {
    const toggleChangesPanel = vi.fn();
    renderConversation(baseSession(), [], {
      review: reviewStub({
        files: [
          { path: "src/a.ts", status: "modified", additions: 3, deletions: 1 },
          { path: "src/b.ts", status: "added", additions: 7, deletions: 0 }
        ],
        toggleChangesPanel
      })
    });

    expect(screen.queryByText("2 files changed")).not.toBeInTheDocument();
    const changesButton = screen.getByRole("button", {
      name: "Open changed files in review panel: 2 files changed, 10 additions, 1 deletion"
    });
    expect(changesButton).toHaveTextContent("+10");
    expect(changesButton).toHaveTextContent("-1");
    expect(changesButton).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(changesButton);
    expect(toggleChangesPanel).toHaveBeenCalledTimes(1);
  });

  it("collapses workspace metadata behind a compact details popover", () => {
    const toggleChangesPanel = vi.fn();
    renderConversation(baseSession({ contextTokens: 10_000, contextWindow: 100_000 }), [], {
      review: reviewStub({
        files: [{ path: "src/a.ts", status: "modified", additions: 5, deletions: 2 }],
        toggleChangesPanel
      })
    });

    const detailsButton = screen.getByRole("button", {
      name: "Workspace details: branch argmax/dashboard, 1 file changed"
    });
    fireEvent.click(detailsButton);

    const popover = screen.getByRole("dialog", { name: "Workspace details" });
    expect(
      within(popover).getByRole("button", {
        name: "Context window 10% full — 10,000 of 100,000 tokens"
      })
    ).toBeInTheDocument();
    expect(within(popover).getByRole("button", { name: "Open worktree at /tmp/worktrees/dashboard" })).toBeInTheDocument();
    const branchLabel = within(popover).getByText("argmax/dashboard");
    expect(branchLabel).toBeInTheDocument();

    const changesButton = within(popover).getByRole("button", {
      name: "Open changed files in review panel: 1 file changed, 5 additions, 2 deletions"
    });
    expect(changesButton.compareDocumentPosition(branchLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(changesButton).toHaveTextContent("+5");
    fireEvent.click(changesButton);
    expect(toggleChangesPanel).toHaveBeenCalledTimes(1);
  });

  it("marks the compact changed-file action pressed when Changes is open", () => {
    renderConversation(baseSession(), [], {
      review: reviewStub({
        files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 1 }],
        isPanelOpen: true,
        mode: "changes"
      })
    });

    expect(
      screen.getByRole("button", {
        name: "Open changed files in review panel: 1 file changed, 1 addition, 1 deletion"
      })
    ).toHaveAttribute("aria-pressed", "true");
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

  it("marks an in-flight assistant bubble with .markdown-streaming while deltas arrive", () => {
    const { container } = renderConversation(
      baseSession({ state: "running" }),
      [
        event("u1", "user.message", "scan repo", "2026-05-12T15:00:00.000Z"),
        event("d1", "message.delta", "1. First\n2. Second", "2026-05-12T15:00:01.000Z")
      ]
    );

    expect(container.querySelector(".markdown-streaming")).not.toBeNull();
    // No blinking-caret DOM element — token-by-token text is the streaming indicator.
    expect(container.querySelectorAll(".streaming-caret")).toHaveLength(0);
  });

  it("does not replay stored delta-only answers when a cancelled session is reopened", () => {
    const text = [
      "Here are 100 items you can buy in a store:",
      "1. Milk 2. Eggs 3. Bread 4. Butter 5. Cheese 6. Yogurt",
      "7. Bananas 8. Apples 9. Oranges 10. Potatoes 11. Onions"
    ].join(" ");
    const { container } = renderConversation(
      baseSession({ state: "cancelled" }),
      [
        event("u1", "user.message", "list 100 items you can buy in a store", "2026-05-12T15:00:00.000Z"),
        event("d1", "message.delta", text, "2026-05-12T15:00:01.000Z")
      ]
    );

    expect(container.querySelector(".markdown-streaming")).toBeNull();
    expect(screen.getByText(/Here are 100 items/)).toBeInTheDocument();
    expect(screen.getByText(/11\. Onions/)).toBeInTheDocument();
  });

  it("drops the streaming class once the assistant message completes", () => {
    const text = "1. First\n2. Second";

    const { container } = renderConversation(
      baseSession({ state: "complete" }),
      [
        event("u1", "user.message", "go", "2026-05-12T15:00:00.000Z"),
        event("m1", "message.completed", text, "2026-05-12T15:00:01.000Z")
      ]
    );

    expect(container.querySelector(".markdown-streaming")).toBeNull();
    expect(container.querySelectorAll(".streaming-caret")).toHaveLength(0);
  });

  it("renders extended-thinking as a collapsed Thought block that persists after the answer", () => {
    const thinking = "The user is asking me to read files. Let me start with the README.";
    const answer = "Here's the repo overview.";

    renderConversation(
      baseSession({ state: "complete" }),
      [
        event("u1", "user.message", "what is this repo", "2026-05-12T15:00:00.000Z"),
        // Extended-thinking is surfaced by the normalizer as a message.delta
        // with payload.thinking === true.
        event("t1", "message.delta", thinking, "2026-05-12T15:00:01.000Z", { thinking: true }),
        event("m1", "message.completed", answer, "2026-05-12T15:00:02.000Z")
      ]
    );

    // The Thought disclosure survives the turn's completion (not pruned), and
    // the answer renders normally alongside it. Done → collapsed, "Thought".
    const toggle = screen.getByRole("button", { name: "Thought" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle.textContent).toContain("Thought");
    expect(screen.getByText(answer)).toBeTruthy();
    // Collapsed by default — the reasoning text is not shown until expanded.
    expect(screen.queryByText(thinking)).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(thinking)).toBeTruthy();
  });

  it("labels a finished thought with its duration when the fragments span seconds", () => {
    renderConversation(
      baseSession({ state: "complete" }),
      [
        event("u1", "user.message", "what is this repo", "2026-05-12T15:00:00.000Z"),
        event("t1", "message.delta", "First look.", "2026-05-12T15:00:01.000Z", { thinking: true }),
        event("t2", "message.delta", " Still looking.", "2026-05-12T15:00:06.000Z", { thinking: true }),
        event("m1", "message.completed", "Here's the repo overview.", "2026-05-12T15:00:07.000Z")
      ]
    );

    expect(screen.getByRole("button", { name: "Thought 5s" })).toBeInTheDocument();
  });

  it("renders completed extended-thinking expanded when the default says to show it", () => {
    const thinking = "I should inspect the settings plumbing before touching the UI.";
    const answer = "Settings are wired.";

    renderConversation(
      baseSession({ state: "complete" }),
      [
        event("u1", "user.message", "wire thinking settings", "2026-05-12T15:00:00.000Z"),
        event("t1", "message.delta", thinking, "2026-05-12T15:00:01.000Z", { thinking: true }),
        event("m1", "message.completed", answer, "2026-05-12T15:00:02.000Z")
      ],
      { defaultThinkingExpanded: true }
    );

    const toggle = screen.getByRole("button", { name: "Thought" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle.textContent).toContain("Thought");
    expect(screen.getByText(thinking)).toBeTruthy();
    expect(screen.getByText(answer)).toBeTruthy();
  });

  it("shows extended-thinking expanded and labelled 'Thinking' while the turn is live", () => {
    const thinking = "Let me figure out which files matter here.";

    renderConversation(
      baseSession({ state: "running" }),
      [
        event("u1", "user.message", "explore the repo", "2026-05-12T15:00:00.000Z"),
        // Thinking has landed but no answer text yet → the turn is live, so the
        // reasoning shows expanded in place of the generic Thinking indicator.
        event("t1", "message.delta", thinking, "2026-05-12T15:00:01.000Z", { thinking: true })
      ]
    );

    const toggle = screen.getByRole("button", { name: "Thinking" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle.textContent).toContain("Thinking");
    expect(screen.getByText(thinking)).toBeTruthy();
  });

  // Reasoning is normalized as a `message.delta` (`thinking: true`), so before
  // this the newest event during a reasoning pause looked like streaming answer
  // text and suppressed the generic indicator. Post-answer that reasoning is a
  // collapsed Thought, so nothing on screen said the agent was still working:
  // observed as a 20 s dead transcript on a running Codex turn.
  it.each([
    { label: "balanced", display: "collapsed" as const },
    { label: "single-line", display: "single-line" as const }
  ])("shows the generic indicator while reasoning continues after an answer ($label)", ({ display }) => {
    vi.useFakeTimers();
    renderConversation(
      baseSession({ provider: "codex", state: "running" }),
      [
        event("t2", "message.delta", "**Planning the next edit**", "2026-05-12T15:00:05.000Z", {
          thinking: true
        }),
        event("c1-end", "command.completed", "Bash", "2026-05-12T15:00:04.000Z", {
          tool_use_id: "tu_git",
          content: "main"
        }),
        event("c1", "command.started", "Bash", "2026-05-12T15:00:03.000Z", {
          type: "tool_use",
          id: "tu_git",
          name: "Bash",
          input: { command: "git status --short" }
        }),
        event("m1", "message.completed", "Agreed, I'll rework the board.", "2026-05-12T15:00:02.000Z"),
        event("t1", "message.delta", "**Weighing the lanes**", "2026-05-12T15:00:01.000Z", {
          thinking: true
        }),
        event("u1", "user.message", "reorder the lanes", "2026-05-12T15:00:00.000Z")
      ],
      { defaultToolCallsDisplay: display }
    );

    expect(screen.queryByRole("article", { name: "Thinking" })).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(screen.getByRole("article", { name: "Thinking" })).toBeInTheDocument();
    // The reasoning is history here, not the cue: no live Thought block claims
    // the beat alongside the generic line.
    expect(screen.queryByRole("button", { name: "Thinking" })).not.toBeInTheDocument();
  });

  it.each([
    { label: "balanced", display: "collapsed" as const },
    { label: "single-line", display: "single-line" as const }
  ])("leaves the pre-answer beat to the live Thought block alone ($label)", ({ display }) => {
    vi.useFakeTimers();
    renderConversation(
      baseSession({ provider: "codex", state: "running" }),
      [
        event("t1", "message.delta", "**Mapping the renderer**", "2026-05-12T15:00:01.000Z", {
          thinking: true
        }),
        event("u1", "user.message", "map the renderer", "2026-05-12T15:00:00.000Z")
      ],
      { defaultToolCallsDisplay: display }
    );

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    // Exactly one cue: the reasoning itself, expanded and labelled "Thinking".
    expect(screen.getByRole("button", { name: "Thinking" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByRole("article", { name: "Thinking" })).not.toBeInTheDocument();
  });

  it("renders a Thought block collapsed when the answer is already there on mount", () => {
    renderConversation(
      baseSession({ state: "running" }),
      [
        event("u1", "user.message", "explore the repo", "2026-05-12T15:00:00.000Z"),
        event("t1", "message.delta", "Reasoning about it.", "2026-05-12T15:00:01.000Z", { thinking: true }),
        // Answer text already present → the block never opened itself here, so
        // there is nothing to hold open: it follows the saved default.
        event("a1", "message.delta", "Here we go", "2026-05-12T15:00:02.000Z")
      ]
    );

    const toggle = screen.getByRole("button", { name: "Thought" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle.textContent).toContain("Thought");
    expect(screen.getByText("Here we go")).toBeTruthy();
  });

  it("holds an open Thought block open when the answer starts, and folds it on the next turn", () => {
    const thinking = "Weighing both designs before I answer.";
    const session = baseSession({ state: "running" });
    const events = [
      event("u1", "user.message", "explore the repo", "2026-05-12T15:00:00.000Z"),
      event("t1", "message.delta", thinking, "2026-05-12T15:00:01.000Z", { thinking: true })
    ];
    const renderWith = (timeline: TimelineEvent[]): ReactElement => (
      <SessionConversation
        events={timeline}
        isLogOpen={false}
        onSendSessionInput={vi.fn().mockResolvedValue(undefined)}
        onTerminateSession={vi.fn().mockResolvedValue(undefined)}
        onToggleLog={vi.fn()}
        project={project}
        rawOutputs={[]}
        review={reviewStub()}
        session={session}
        workspace={workspace}
      />
    );
    const { rerender } = renderConversation(session, events);
    expect(screen.getByRole("button", { name: "Thinking" })).toHaveAttribute("aria-expanded", "true");

    // The answer starts arriving. The label settles to "Thought", but folding
    // the body away here would take its whole height out of the transcript at
    // the exact moment the agent starts writing. A reader pinned to the
    // bottom gets pulled up by that much.
    const answering = [...events, event("a1", "message.delta", "Here we go", "2026-05-12T15:00:02.000Z")];
    rerender(renderWith(answering));

    const settled = screen.getByRole("button", { name: "Thought" });
    expect(settled).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(thinking)).toBeTruthy();

    // A newer turn takes over: now the reasoning folds, above a viewport full
    // of the answer it belongs to.
    rerender(
      renderWith([...answering, event("u2", "user.message", "now ship it", "2026-05-12T15:00:03.000Z")])
    );

    expect(screen.getByRole("button", { name: "Thought" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(thinking)).toBeNull();
  });

  it("collapses the Thought block when the turn chip collapses the turn", () => {
    const thinking = "Mapping the modules before I touch anything.";
    renderConversation(
      baseSession({ state: "complete" }),
      [
        event("u1", "user.message", "explore", "2026-05-12T15:00:00.000Z"),
        event("t1", "message.delta", thinking, "2026-05-12T15:00:01.000Z", { thinking: true }),
        event("c1", "command.started", "Read", "2026-05-12T15:00:02.000Z", {
          id: "c1",
          name: "Read",
          input: { file_path: "architecture.md" }
        }),
        event("c1-end", "command.completed", "Read", "2026-05-12T15:00:03.000Z", { id: "c1", content: "" }),
        event("m1", "message.completed", "Done.", "2026-05-12T15:00:04.000Z")
      ],
      {
        defaultThinkingExpanded: true,
        defaultToolCallsDisplay: "expanded",
        defaultToolCallGroupsExpanded: true
      }
    );

    expect(screen.getByRole("button", { name: "Thought" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(thinking)).toBeTruthy();

    // The turn chip folds the whole turn — tool groups AND the Thought block.
    fireEvent.click(screen.getByRole("button", { name: /Worked/ }));

    expect(screen.getByRole("button", { name: "Thought" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(thinking)).toBeNull();
  });

  it("expands the Thought block when the turn chip expands the turn", () => {
    const thinking = "Checking the IPC layer first.";
    renderConversation(
      baseSession({ state: "complete" }),
      [
        event("u1", "user.message", "explore", "2026-05-12T15:00:00.000Z"),
        event("t1", "message.delta", thinking, "2026-05-12T15:00:01.000Z", { thinking: true }),
        event("c1", "command.started", "Read", "2026-05-12T15:00:02.000Z", {
          id: "c1",
          name: "Read",
          input: { file_path: "ipc.md" }
        }),
        event("c1-end", "command.completed", "Read", "2026-05-12T15:00:03.000Z", { id: "c1", content: "" }),
        event("m1", "message.completed", "Done.", "2026-05-12T15:00:04.000Z")
      ],
      {
        defaultThinkingExpanded: false,
        defaultToolCallsDisplay: "collapsed",
        defaultToolCallGroupsExpanded: false
      }
    );

    expect(screen.getByRole("button", { name: "Thought" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(thinking)).toBeNull();

    // Chip starts collapsed (tool defaults off); expanding it reveals the
    // Thought block too, not just the tool rows.
    fireEvent.click(screen.getByRole("button", { name: /Worked/ }));

    expect(screen.getByRole("button", { name: "Thought" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(thinking)).toBeTruthy();
  });

  it("accumulates streamed text_delta fragments into a single bubble", () => {
    // Token streaming: many small message.delta fragments fold into one bubble.
    renderConversation(
      baseSession({ state: "running" }),
      [
        event("u1", "user.message", "hi", "2026-05-12T15:00:00.000Z"),
        event("d1", "message.delta", "Hel", "2026-05-12T15:00:01.000Z"),
        event("d2", "message.delta", "lo ", "2026-05-12T15:00:02.000Z"),
        event("d3", "message.delta", "world", "2026-05-12T15:00:03.000Z")
      ]
    );

    expect(screen.getAllByText("Hello world")).toHaveLength(1);
  });

  it("does not duplicate the answer when message.completed lands after streamed fragments", () => {
    // `events` arrives newest-first (as mergeDashboardDelta sorts it); the
    // supersede filter drops the streamed deltas once the completion lands.
    renderConversation(
      baseSession({ state: "complete" }),
      [
        event("m1", "message.completed", "Hello world", "2026-05-12T15:00:04.000Z"),
        event("d3", "message.delta", "world", "2026-05-12T15:00:03.000Z"),
        event("d2", "message.delta", "lo ", "2026-05-12T15:00:02.000Z"),
        event("d1", "message.delta", "Hel", "2026-05-12T15:00:01.000Z"),
        event("u1", "user.message", "hi", "2026-05-12T15:00:00.000Z")
      ]
    );

    // The streamed deltas are superseded by the completion → exactly one bubble.
    expect(screen.getAllByText("Hello world")).toHaveLength(1);
  });

  it("keeps Cursor narration, tools, and later streamed answer in chronological order", () => {
    const { container } = renderConversation(
      baseSession({ provider: "cursor", state: "running" }),
      [
        event("a2", "message.delta", "Here is the answer", "2026-05-12T15:00:05.000Z", cursorAssistantPayload("Here is the answer")),
        event("c1", "command.started", "Read", "2026-05-12T15:00:03.000Z", {
          id: "c1",
          name: "Read",
          input: { file_path: "architecture.md" }
        }),
        event("a1", "message.delta", "Reading the file first.", "2026-05-12T15:00:02.000Z", cursorAssistantPayload("Reading the file first.")),
        event("u1", "user.message", "summarize", "2026-05-12T15:00:00.000Z")
      ]
    );

    const text = container.querySelector(".conversation-list")?.textContent ?? "";
    expect(text).toContain("architecture.md");
    expect(text.indexOf("Reading the file first.")).toBeLessThan(text.indexOf("architecture.md"));
    expect(text.indexOf("architecture.md")).toBeLessThan(text.indexOf("Here is the answer"));
  });

  it("keeps a still-streaming pre-tool narration above the started tool", () => {
    const { container } = renderConversation(
      baseSession({ provider: "cursor", state: "running" }),
      [
        event("c1", "command.started", "Read", "2026-05-12T15:00:03.000Z", {
          id: "c1",
          name: "Read",
          input: { file_path: "architecture.md" }
        }),
        event(
          "a1",
          "message.delta",
          "Reading the file",
          "2026-05-12T15:00:02.000Z",
          cursorAssistantPayload("Reading the file")
        ),
        event("u1", "user.message", "summarize", "2026-05-12T15:00:00.000Z")
      ]
    );

    const text = container.querySelector(".conversation-list")?.textContent ?? "";
    expect(text).toContain("architecture.md");
    expect(text).toContain("Reading the file");
    expect(text.indexOf("Reading the file")).toBeLessThan(text.indexOf("architecture.md"));
  });

  it("keeps a completed pre-tool narration above the tool it precedes", () => {
    // A narration chunk that COMPLETED before the tool started is anchored at its
    // own time and must stay above the tool.
    const { container } = renderConversation(
      baseSession({ provider: "claude", state: "running" }),
      [
        event("c1", "command.started", "Read", "2026-05-12T15:00:03.000Z", {
          id: "c1",
          name: "Read",
          input: { file_path: "architecture.md" }
        }),
        event("m1", "message.completed", "Let me read the file", "2026-05-12T15:00:02.500Z"),
        event("d1", "message.delta", "Let me read the file", "2026-05-12T15:00:02.000Z"),
        event("u1", "user.message", "summarize", "2026-05-12T15:00:00.000Z")
      ]
    );

    const text = container.querySelector(".conversation-list")?.textContent ?? "";
    expect(text).toContain("Let me read the file");
    expect(text.indexOf("Let me read the file")).toBeLessThan(text.indexOf("architecture.md"));
  });

  it("keeps Codex command groups separated by assistant prose", () => {
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

    // Assistant prose is a real boundary: the first command belongs above the
    // prose, while the later adjacent commands fold together below it.
    expect(screen.getByRole("button", { name: /Ran 1 command/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Ran 2 commands/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Ran 3 commands/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/\/bin\/zsh/)).not.toBeInTheDocument();
  });

  it("renders a user.message bubble for an @-mention-only prompt while the session is still running", () => {
    renderConversation(
      baseSession({ state: "running" }),
      [event("u1", "user.message", "@AGENTS.md", "2026-05-12T15:00:00.000Z")]
    );

    const bubbleText = screen.getByText("@AGENTS.md", { selector: "p" });
    expect(bubbleText.closest(".chat-bubble.user")).not.toBeNull();
  });

  it("renders image attachments as previews above user.message bubbles", () => {
    const imagePath =
      "/Users/me/Library/Application Support/argmax/local-state/attachments/session-a/screenshot 1.png";
    const { container } = renderConversation(
      baseSession({ state: "running" }),
      [
        event(
          "u1",
          "user.message",
          `Check this screenshot @${imagePath}`,
          "2026-05-12T15:00:00.000Z",
          {
            attachments: [{ filePath: imagePath, mimeType: "image/png", sizeBytes: 1234 }]
          }
        )
      ]
    );

    const image = screen.getByRole("img", { name: "Attached image: screenshot 1.png" });
    const bubble = screen.getByText("Check this screenshot", { selector: "p" }).closest(".chat-bubble.user");
    const attachmentStrip = image.closest(".user-message-attachments");
    expect(image).toHaveAttribute("src", attachmentProtocolUrl(imagePath));
    expect(bubble).not.toBeNull();
    expect(attachmentStrip).not.toBeNull();
    expect(bubble?.contains(image)).toBe(false);
    expect(attachmentStrip?.nextElementSibling).toBe(bubble);
    expect(screen.queryByText("screenshot 1.png")).toBeNull();
    expect(container.querySelector(".chat-bubble.user")?.textContent).not.toContain(`@${imagePath}`);
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

  it("hides sub-agent prompt echoes tagged with parent_tool_use_id", () => {
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
            prompt: "Explore the documentation in this Tauri/React Argmax project."
          }
        }),
        event(
          "m-subagent-prompt",
          "message.delta",
          "Explore the documentation in this Tauri/React Argmax project.",
          "2026-05-12T15:00:02.000Z",
          {
            type: "user",
            parent_tool_use_id: "toolu_parent_task",
            subagent_type: "Explore"
          }
        )
      ]
    );

    expect(screen.getByLabelText(startedAgentName("Map documentation structure and identify gaps"))).toBeInTheDocument();
    // What must not come back is the echoed child bubble in the parent stream.
    expect(
      screen.queryByText("Explore the documentation in this Tauri/React Argmax project.", { selector: "p" })
    ).not.toBeInTheDocument();
  });
  it("keeps Thinking for Claude when session.streaming fired before assistant text", () => {
    renderConversation(
      baseSession({ provider: "claude", state: "running" }),
      [
        event("stream", "session.streaming", "", "2026-05-12T15:00:00.500Z"),
        event("u1", "user.message", "hey", "2026-05-12T15:00:00.000Z")
      ]
    );

    expect(screen.getByLabelText("Thinking")).toBeInTheDocument();
  });

  it("keeps Thinking for Codex during the pre-content wait after session.streaming", () => {
    // Codex fires session.streaming on the child's first raw byte, then spends
    // seconds reasoning before any visible item lands. The beacon is not
    // user-visible progress, so Thinking must stay up to show the agent is
    // working — it yields once a real message/tool arrives.
    renderConversation(
      baseSession({ provider: "codex", state: "running" }),
      [
        event("stream", "session.streaming", "", "2026-05-12T15:00:00.500Z"),
        event("u1", "user.message", "hey", "2026-05-12T15:00:00.000Z")
      ]
    );

    expect(screen.getByLabelText("Thinking")).toBeInTheDocument();
  });

  it("renders a curated thinking word with the shared live-work mark", () => {
    const { container } = renderConversation(
      baseSession({ provider: "codex", state: "running" }),
      [event("u1", "user.message", "hey", "2026-05-12T15:00:00.000Z")]
    );

    expect(THINKING_WORDS).toContain(screen.getByTestId("thinking-label").textContent);
    expect(screen.getByTestId("thinking-label").querySelector('[data-working="true"]')).not.toBeNull();
    expect(container.querySelector(".thinking-label")).not.toBeNull();
  });

  it("keeps the Thinking line's slot in the list whether or not the line is in it", () => {
    // The slot is the CSS contract itself (chat-conversation.css reserves
    // `.conversation-tail`'s height): the Thinking line sits after the
    // transcript and leaves the moment the answer starts, so the row has
    // to hold its space or a transcript pinned to the bottom jumps by its height.
    const live = renderConversation(
      baseSession({ provider: "codex", state: "running" }),
      [event("u1", "user.message", "hey", "2026-05-12T15:00:00.000Z")]
    );
    expect(screen.getByLabelText("Thinking").closest(".conversation-tail")).not.toBeNull();
    live.unmount();

    const settled = renderConversation(
      baseSession({ provider: "codex", state: "complete" }),
      [
        event("u1", "user.message", "hey", "2026-05-12T15:00:00.000Z"),
        event("m1", "message.completed", "Done.", "2026-05-12T15:00:01.000Z")
      ]
    );
    expect(screen.queryByLabelText("Thinking")).toBeNull();
    expect(settled.container.querySelector(".conversation-tail")).not.toBeNull();
  });

  it("marks only the latest user message as the turn-start anchor", () => {
    renderConversation(
      baseSession({ provider: "codex", state: "complete" }),
      [
        event("u1", "user.message", "first prompt", "2026-05-12T15:00:00.000Z"),
        event("m1", "message.completed", "First reply.", "2026-05-12T15:00:01.000Z"),
        event("u2", "user.message", "follow-up", "2026-05-12T15:00:02.000Z")
      ]
    );

    expect(screen.getByText("first prompt").closest("[data-turn-anchor]")).toBeNull();
    expect(screen.getByText("follow-up").closest("[data-turn-anchor]")).not.toBeNull();
  });

  it("hides Thinking for Codex once a visible tool starts running", () => {
    renderConversation(
      baseSession({ provider: "codex", state: "running" }),
      [
        event("u1", "user.message", "run it", "2026-05-12T15:00:00.000Z"),
        event("stream", "session.streaming", "", "2026-05-12T15:00:00.500Z"),
        event("cmd-start", "command.started", "command_execution", "2026-05-12T15:00:01.000Z", {
          id: "cmd1",
          name: "command_execution",
          input: { command: "/bin/zsh -lc 'ls'" }
        })
      ]
    );

    expect(screen.queryByLabelText("Thinking")).not.toBeInTheDocument();
  });

  it("delays Thinking after a completed assistant chunk while the session is still running", () => {
    vi.useFakeTimers();
    // A completed assistant chunk is often the final answer, with the backend
    // state flip arriving in the next delta. Give that terminal update a
    // longer grace period so the UI does not flash a bogus tail Thinking
    // bubble, while still marking genuinely long mid-turn silences.
    renderConversation(
      baseSession({ provider: "claude", state: "running" }),
      [
        event("m1", "message.completed", "Done.", "2026-05-12T15:00:01.000Z"),
        event("u1", "user.message", "do a thing", "2026-05-12T15:00:00.000Z")
      ]
    );

    expect(screen.getByText("Done.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Thinking")).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(screen.queryByLabelText("Thinking")).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(screen.getByLabelText("Thinking")).toBeInTheDocument();
  });

  it("does not flash Thinking when the session completes during the post-answer grace period", () => {
    vi.useFakeTimers();
    const events = [
      event("m1", "message.completed", "Done.", "2026-05-12T15:00:01.000Z"),
      event("u1", "user.message", "do a thing", "2026-05-12T15:00:00.000Z")
    ];
    const baseProps = {
      events,
      isLogOpen: false,
      onSendSessionInput: vi.fn().mockResolvedValue(undefined),
      onTerminateSession: vi.fn().mockResolvedValue(undefined),
      onToggleLog: vi.fn(),
      project,
      rawOutputs: [],
      review: reviewStub(),
      workspace
    };

    const { rerender } = render(
      <SessionConversation
        {...baseProps}
        session={baseSession({ provider: "claude", state: "running" })}
      />
    );

    expect(screen.getByText("Done.")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(screen.queryByLabelText("Thinking")).not.toBeInTheDocument();

    rerender(
      <SessionConversation
        {...baseProps}
        session={baseSession({ provider: "claude", state: "complete" })}
      />
    );
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByLabelText("Thinking")).not.toBeInTheDocument();
  });

  it("shows generic Thinking after a long completed assistant chunk pause", () => {
    vi.useFakeTimers();
    // Once a durable assistant chunk exists, the transcript still needs a live
    // marker during a long silent mid-turn pause.
    renderConversation(
      baseSession({ provider: "claude", state: "running" }),
      [
        event("m1", "message.completed", "Now I'll edit the file.", "2026-05-12T15:00:01.000Z"),
        event("u1", "user.message", "edit it", "2026-05-12T15:00:00.000Z")
      ]
    );

    expect(screen.getByText("Now I'll edit the file.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Working" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Thinking")).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(screen.queryByLabelText("Thinking")).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(screen.getByLabelText("Thinking")).toBeInTheDocument();
  });

  it("drops Thinking when an atomic answer lands, without waiting for the state flip", () => {
    vi.useFakeTimers();
    // Codex and OpenCode deliver an answer as a single `message.completed` —
    // there are no answer deltas, so the reasoning gap before it is what puts
    // the label up and nothing later arrives to take it down. The session stays
    // `running` until the provider process exits about a second after the last
    // message, so keying the hide on that flip left the label sitting under a
    // finished answer for that whole second.
    const reasoning = event("r1", "message.delta", "**Drafting the summary**", "2026-05-12T15:00:01.000Z", {
      thinking: true
    });
    const userMessage = event("u1", "user.message", "summarize it", "2026-05-12T15:00:00.000Z");
    const baseProps = {
      isLogOpen: false,
      onSendSessionInput: vi.fn().mockResolvedValue(undefined),
      onTerminateSession: vi.fn().mockResolvedValue(undefined),
      onToggleLog: vi.fn(),
      project,
      rawOutputs: [],
      review: reviewStub(),
      workspace
    };
    const running = baseSession({ provider: "codex", state: "running" });

    const { rerender } = render(
      <SessionConversation {...baseProps} events={[reasoning, userMessage]} session={running} />
    );
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(screen.getByLabelText("Thinking")).toBeInTheDocument();

    rerender(
      <SessionConversation
        {...baseProps}
        events={[
          event("m1", "message.completed", "Here is the summary.", "2026-05-12T15:00:03.000Z"),
          reasoning,
          userMessage
        ]}
        session={running}
      />
    );
    // Past the minimum-visible clamp, which is all that may hold it on screen.
    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(screen.getByText("Here is the summary.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Thinking")).not.toBeInTheDocument();
    // Still running, still silent — and still no tail label until the answer's
    // window is spent and the pause is a genuine mid-turn one.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByLabelText("Thinking")).not.toBeInTheDocument();
  });

  it("shows generic Thinking after a completed tool row", () => {
    vi.useFakeTimers();
    // Tool chaining (grep → read → grep) leaves a `command.completed` as the
    // last significant event while the model picks the next call. Show Thinking
    // during that silent gap.
    renderConversation(
      baseSession({ provider: "claude", state: "running" }),
      [
        event("c1-end", "command.completed", "Bash", "2026-05-12T15:00:02.000Z", {
          tool_use_id: "tu_grep",
          content: "match"
        }),
        event("c1", "command.started", "Bash", "2026-05-12T15:00:01.000Z", {
          type: "tool_use",
          id: "tu_grep",
          name: "Bash",
          input: { command: "grep foo" }
        }),
        event("u1", "user.message", "explore", "2026-05-12T15:00:00.000Z")
      ]
    );

    expect(screen.getByRole("button", { name: /Ran 1 command/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Working/ })).toBeInTheDocument();
    expect(screen.queryByLabelText("Thinking")).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(screen.getByLabelText("Thinking")).toBeInTheDocument();
  });

  it("keeps Thinking steady while a launched subagent works and only the child emits events", () => {
    vi.useFakeTimers();
    // Background launch: the Task row completes immediately, the parent then
    // waits. Child tool rows fold under the launch row and never render here,
    // so a child heartbeat must not toggle the parent's Thinking label.
    const waiting = [
      event("m1", "message.completed", "Exploration agent is running in the background.", "2026-05-12T15:00:03.000Z"),
      event("task-end", "command.completed", "tool_result", "2026-05-12T15:00:02.000Z", {
        tool_use_id: "toolu_task",
        content: "Agent launched"
      }),
      event("task", "command.started", "Task", "2026-05-12T15:00:01.000Z", {
        type: "tool_use",
        id: "toolu_task",
        name: "Task",
        input: { description: "Explore this repo", prompt: "Explore the repo quickly." }
      }),
      event("u1", "user.message", "launch a subagent", "2026-05-12T15:00:00.000Z")
    ];
    const baseProps = {
      isLogOpen: false,
      onSendSessionInput: vi.fn().mockResolvedValue(undefined),
      onTerminateSession: vi.fn().mockResolvedValue(undefined),
      onToggleLog: vi.fn(),
      project,
      rawOutputs: [],
      review: reviewStub(),
      session: baseSession({ provider: "claude", state: "running" }),
      workspace
    };

    const { rerender } = render(<SessionConversation {...baseProps} events={waiting} />);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByLabelText("Thinking")).toBeInTheDocument();

    // The child starts its own tool, then finishes it. Both are invisible in
    // the parent chat, so Thinking stays up across the whole heartbeat.
    const childRunning = [
      event("child-1", "command.started", "Grep", "2026-05-12T15:00:04.000Z", {
        type: "tool_use",
        id: "toolu_child",
        name: "Grep",
        input: { pattern: "thinking" },
        parent_tool_use_id: "toolu_task"
      }),
      ...waiting
    ];
    rerender(<SessionConversation {...baseProps} events={childRunning} />);
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(screen.getByLabelText("Thinking")).toBeInTheDocument();

    const childDone = [
      event("child-1-end", "command.completed", "tool_result", "2026-05-12T15:00:05.000Z", {
        tool_use_id: "toolu_child",
        content: "match"
      }),
      ...childRunning
    ];
    rerender(<SessionConversation {...baseProps} events={childDone} />);
    act(() => {
      vi.advanceTimersByTime(700);
    });
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

  it("shows Thinking immediately after a follow-up is sent, before the session flips to running", () => {
    vi.useFakeTimers();
    // The backend relaunches the agent for a follow-up, so the transcript gets
    // the new user bubble seconds before any provider event (and sometimes
    // before the `running` state) arrives. The pane must not sit blank for
    // that whole spawn: no timer advance, Thinking is already up.
    const previousTurn = [
      event("m1", "message.completed", "Done.", "2026-05-12T15:00:01.000Z"),
      event("u1", "user.message", "do a thing", "2026-05-12T15:00:00.000Z")
    ];
    render(
      <SessionConversation
        events={previousTurn}
        isLogOpen={false}
        onSendSessionInput={vi.fn(() => new Promise<void>(() => {}))}
        onTerminateSession={vi.fn().mockResolvedValue(undefined)}
        onToggleLog={vi.fn()}
        project={project}
        rawOutputs={[]}
        review={reviewStub()}
        session={baseSession({ provider: "codex", state: "complete" })}
        workspace={workspace}
      />
    );

    expect(screen.queryByLabelText("Thinking")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Session prompt"), {
      target: { value: "and now the tests" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send follow-up" }));

    expect(screen.getByLabelText("Thinking")).toBeInTheDocument();
  });

  it("shows Thinking immediately for a follow-up queued mid-turn, skipping the post-answer grace period", () => {
    vi.useFakeTimers();
    // Queued follow-ups drain after the current turn, so the running session's
    // newest event is still the previous answer. Without the local turn-start
    // state that answer's 1800 ms grace period gates the indicator.
    render(
      <SessionConversation
        events={[
          event("m1", "message.completed", "Done.", "2026-05-12T15:00:01.000Z"),
          event("u1", "user.message", "do a thing", "2026-05-12T15:00:00.000Z")
        ]}
        isLogOpen={false}
        onSendSessionInput={vi.fn(() => new Promise<void>(() => {}))}
        onTerminateSession={vi.fn().mockResolvedValue(undefined)}
        onToggleLog={vi.fn()}
        project={project}
        rawOutputs={[]}
        review={reviewStub()}
        session={baseSession({ provider: "claude", state: "running" })}
        workspace={workspace}
      />
    );

    const prompt = screen.getByLabelText("Session prompt");
    fireEvent.change(prompt, { target: { value: "then run lint" } });
    fireEvent.keyDown(prompt, { key: "Enter" });

    expect(screen.getByLabelText("Thinking")).toBeInTheDocument();
  });

  it("yields the post-send Thinking state to the first visible assistant text", () => {
    vi.useFakeTimers();
    const previousTurn = [
      event("m1", "message.completed", "Done.", "2026-05-12T15:00:01.000Z"),
      event("u1", "user.message", "do a thing", "2026-05-12T15:00:00.000Z")
    ];
    const baseProps = {
      isLogOpen: false,
      onSendSessionInput: vi.fn(() => new Promise<void>(() => {})),
      onTerminateSession: vi.fn().mockResolvedValue(undefined),
      onToggleLog: vi.fn(),
      project,
      rawOutputs: [],
      review: reviewStub(),
      session: baseSession({ provider: "codex", state: "running" }),
      workspace
    };

    const { rerender } = render(<SessionConversation {...baseProps} events={previousTurn} />);
    fireEvent.change(screen.getByLabelText("Session prompt"), {
      target: { value: "and now the tests" }
    });
    fireEvent.keyDown(screen.getByLabelText("Session prompt"), { key: "Enter" });
    expect(screen.getByLabelText("Thinking")).toBeInTheDocument();

    // The provider takes over: the user bubble lands and the answer streams.
    const answering = [
      event("d1", "message.delta", "Writing them now", "2026-05-12T15:00:04.000Z"),
      event("u2", "user.message", "and now the tests", "2026-05-12T15:00:03.000Z"),
      ...previousTurn
    ];
    rerender(<SessionConversation {...baseProps} events={answering} />);
    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(screen.getByText("Writing them now")).toBeInTheDocument();
    expect(screen.queryByLabelText("Thinking")).not.toBeInTheDocument();
  });

  it("drops the post-send Thinking state when the send itself fails", async () => {
    const failingSend = vi.fn().mockRejectedValue(new Error("Workspace archive is in progress"));
    render(
      <SessionConversation
        events={[event("u1", "user.message", "do a thing", "2026-05-12T15:00:00.000Z")]}
        isLogOpen={false}
        onSendSessionInput={failingSend}
        onTerminateSession={vi.fn().mockResolvedValue(undefined)}
        onToggleLog={vi.fn()}
        project={project}
        rawOutputs={[]}
        review={reviewStub()}
        session={baseSession({ provider: "codex", state: "complete" })}
        workspace={workspace}
      />
    );

    fireEvent.change(screen.getByLabelText("Session prompt"), {
      target: { value: "and now the tests" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send follow-up" }));

    // Send failures are errors now: the composer status line carries
    // role="alert" for them, not role="status".
    expect(await screen.findByRole("alert")).toHaveTextContent("Workspace archive is in progress");
    // The label honours its minimum visible window before it drops.
    await waitFor(() => expect(screen.queryByLabelText("Thinking")).not.toBeInTheDocument());
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
    // Stop is the only send-slot control while running: Enter queues the
    // follow-up, and interrupting is the queued chip's explicit "Send now".
    expect(screen.getByRole("button", { name: "Stop session" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send now" })).not.toBeInTheDocument();
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

  it("sends a queued follow-up immediately from its queue row", async () => {
    let resolveSend: (() => void) | undefined;
    const onSendQueuedMessageNow = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        })
    );
    const pending: PendingMessage[] = [
      {
        id: "queued-1",
        sessionId: "session-a",
        content: "use the simpler approach",
        agentMode: "auto",
        queuedAt: "2026-05-12T15:30:30.000Z"
      }
    ];

    renderConversation(baseSession({ state: "running" }), [], {
      pendingMessages: pending,
      onSendQueuedMessageNow
    });

    expect(screen.getByText("Queued")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Send queued follow-up now: use the simpler approach"
      })
    );

    await waitFor(() =>
      expect(onSendQueuedMessageNow).toHaveBeenCalledWith("session-a", "queued-1")
    );
    expect(screen.getByRole("button", { name: "Stop session" })).toBeDisabled();

    resolveSend?.();
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop session" })).toBeEnabled());
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

  // Regression: until the first message.delta/message.completed/command.started
  // landed, the chat fell back to rendering buildTerminalTranscript(rawOutputs)
  // — a giant gray <pre> dump of the provider's stream-json (8 KB Claude
  // `system`/`init` payload + rate_limit_event). The fix counts the
  // `session.streaming` one-shot beacon as "renderable content" so the dump
  // never reaches the user during the pre-answer thinking window.
  it("suppresses the raw-stdout transcript once session.streaming fires", () => {
    const sess = baseSession({ id: "session-a", state: "running" });
    const userEvent: TimelineEvent = event(
      "u1",
      "user.message",
      "explore",
      "2026-05-12T15:00:00.000Z"
    );
    const streamingBeacon: TimelineEvent = {
      id: "ss-1",
      sessionId: sess.id,
      type: "session.streaming",
      message: "",
      payload: {},
      createdAt: "2026-05-12T15:00:00.500Z"
    };
    // Two raw chunks that together exceed an 8 KB stream-json line without
    // ever forming a complete `{...}` parseable object. `buildTerminalTranscript`
    // hides whole-line JSON via tryParseJsonObject; chunks that arrive
    // mid-line (no trailing newline) survive the filter and end up dumped
    // verbatim — that's the exact scenario the user hit when Claude's first
    // 8 KB system-init blob streamed in across nine partial PTY reads.
    const rawOutputs: RawProviderOutput[] = [
      {
        id: "r1",
        sessionId: sess.id,
        stream: "stdout",
        content: '{"type":"system","subtype":"init","cwd":"/x","tools":["A"',
        createdAt: "2026-05-12T15:00:00.700Z"
      }
    ];

    const baseProps = {
      isLogOpen: false,
      onSendSessionInput: vi.fn().mockResolvedValue(undefined),
      onTerminateSession: vi.fn().mockResolvedValue(undefined),
      onToggleLog: vi.fn(),
      project,
      review: reviewStub(),
      session: sess,
      workspace
    } as const;

    // Without the beacon: transcript fallback should appear so the existing
    // behaviour for non-stream-json providers (where raw stdout IS the
    // human-readable output) keeps working.
    const without = render(
      <SessionConversation
        {...baseProps}
        events={[userEvent]}
        rawOutputs={rawOutputs}
      />
    );
    expect(without.container.querySelector(".terminal-transcript")).not.toBeNull();
    cleanup();

    // With the beacon: transcript suppressed even though the user hasn't seen
    // any normalized text yet. The chat shows an empty/Thinking state instead
    // of the JSON wall.
    const withBeacon = render(
      <SessionConversation
        {...baseProps}
        events={[streamingBeacon, userEvent]}
        rawOutputs={rawOutputs}
      />
    );
    expect(withBeacon.container.querySelector(".terminal-transcript")).toBeNull();
  });

});
