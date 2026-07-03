import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachmentProtocolUrl } from "../../shared/attachmentProtocol.js";
import type { PendingMessage, RawProviderOutput, TimelineEvent } from "../../shared/types.js";
import { SessionConversation } from "./SessionConversation.js";
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
  it("does not reset the model picker when the session prop reference changes but id stays the same", () => {
    const v1 = baseSession({
      modelLabel: "GPT-5.3 Codex",
      modelId: "gpt-5.5",
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
      modelId: "gpt-5.5",
      reasoningEffort: "medium"
    });
    const { rerender } = renderConversation(original);
    expect(screen.getByRole("button", { name: "Session model" }).textContent).toContain("GPT-5.3 Codex");

    const switched = baseSession({
      id: "session-b",
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

  it("marks the branch chip label as ellipsis-safe", () => {
    renderConversation(baseSession());

    const branchChip = screen.getByRole("button", { name: "Branch argmax/dashboard" });
    expect(branchChip).toHaveClass("composer-footer-chip--branch");
    expect(branchChip.querySelector(".composer-footer-chip-label")).toHaveTextContent(
      "argmax/dashboard"
    );
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

  it("collapses the Thought block to 'Thought' once the first answer token arrives", () => {
    renderConversation(
      baseSession({ state: "running" }),
      [
        event("u1", "user.message", "explore the repo", "2026-05-12T15:00:00.000Z"),
        event("t1", "message.delta", "Reasoning about it.", "2026-05-12T15:00:01.000Z", { thinking: true }),
        // First streamed answer token → thinking is no longer live → collapses.
        event("a1", "message.delta", "Here we go", "2026-05-12T15:00:02.000Z")
      ]
    );

    const toggle = screen.getByRole("button", { name: "Thought" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle.textContent).toContain("Thought");
    expect(screen.getByText("Here we go")).toBeTruthy();
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
      { defaultThinkingExpanded: true, defaultToolCallsExpanded: true, defaultToolCallGroupsExpanded: true }
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
      { defaultThinkingExpanded: false, defaultToolCallsExpanded: false, defaultToolCallGroupsExpanded: false }
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
    expect(screen.getByRole("button", { name: /Ran a command: sed/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Ran 2 commands: rg · npm run/ })).toBeInTheDocument();
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

    expect(screen.getByLabelText("Started agent Map documentation structure and identify gaps")).toBeInTheDocument();
    expect(screen.queryByText("Explore the documentation in this Tauri/React Argmax project.")).not.toBeInTheDocument();
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

  it("renders the pulsing Thinking label while the agent thinks", () => {
    const { container } = renderConversation(
      baseSession({ provider: "codex", state: "running" }),
      [event("u1", "user.message", "hey", "2026-05-12T15:00:00.000Z")]
    );

    expect(screen.getByLabelText("Thinking")).toHaveTextContent("Thinking");
    expect(screen.getByTestId("thinking-label")).toHaveTextContent("Thinking");
    expect(container.querySelector(".thinking-label")).not.toBeNull();
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

  it("shows Thinking after a completed assistant chunk while the session is still running", () => {
    vi.useFakeTimers();
    // Completed assistant chunks can be followed by more silent work. Keep a
    // quiet live marker below the chunk until the next visible thing arrives or
    // the session leaves running.
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
    expect(screen.getByLabelText("Thinking")).toBeInTheDocument();
  });

  it("shows generic Thinking after a completed assistant chunk", () => {
    vi.useFakeTimers();
    // Once a durable assistant chunk exists, the transcript still needs a live
    // marker during a silent mid-turn pause.
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
    expect(screen.getByLabelText("Thinking")).toBeInTheDocument();
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

    expect(screen.getByRole("button", { name: /Ran a command/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Working/ })).toBeInTheDocument();
    expect(screen.queryByLabelText("Thinking")).not.toBeInTheDocument();
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
      onCreateCheckpoint: vi.fn().mockResolvedValue(undefined),
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
