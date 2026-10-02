import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { JSX } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../../shared/types.js";
import type { RenderItem } from "../lib/foldConversation.js";
import type { ToolCall } from "../lib/toolCalls.js";
import type { TodoList } from "../lib/todoList.js";
import type * as TurnFileChanges from "../lib/turnFileChanges.js";
import type { ThinkingDisplay, ToolCallsDisplay } from "../lib/uiPreferences.js";
import type { TranscriptFollow } from "../hooks/useConversationScroll.js";

const collectTurnFileChanges = vi.hoisted(() => vi.fn(() => []));

// Only the collector is stubbed — it is what this file counts calls to. The
// rest of the module stays real so the turn keeps summing its own changes.
vi.mock("../lib/turnFileChanges.js", async (importOriginal) => ({
  ...(await importOriginal<typeof TurnFileChanges>()),
  collectTurnFileChanges
}));

const { SessionConversationTurn } = await import("./SessionConversationTurn.js");

const session: SessionSummary = {
  id: "session-a",
  workspaceId: "workspace-1",
  provider: "claude",
  modelLabel: "Sonnet 5.5",
  modelId: "claude-sonnet-5-5",
  permissionMode: "auto-approve",
  providerConversationId: null,
  prompt: "Edit the file",
  state: "complete",
  attention: "normal",
  startedAt: "2026-05-12T15:00:00.000Z",
  completedAt: "2026-05-12T15:00:09.000Z",
  lastActivityAt: "2026-05-12T15:00:09.000Z",
  costUsd: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextTokens: 0,
  imported: false,
  launchKind: "agent"
};

const edit: ToolCall = {
  id: "edit-1",
  toolUseId: "edit-1",
  name: "Edit",
  inputPreview: "src/app.ts",
  inputFull: { file_path: "src/app.ts", old_string: "a", new_string: "b" },
  output: null,
  status: "done",
  createdAt: "2026-05-12T15:00:02.000Z",
  completedAt: "2026-05-12T15:00:03.000Z",
  error: null
};

const agent: ToolCall = {
  ...edit,
  id: "agent-1",
  toolUseId: "agent-1",
  name: "Agent",
  inputPreview: "Map the design",
  inputFull: { description: "Map the design", prompt: "Inspect the chat timeline" },
  createdAt: "2026-05-12T15:00:03.000Z"
};

const plan: TodoList = {
  items: [{ id: "step-1", text: "Review the changes", status: "active" }],
  updatedAt: "2026-05-12T15:00:03.500Z",
  doneCount: 0,
  active: { id: "step-1", text: "Review the changes", status: "active" }
};

const turn: Extract<RenderItem, { kind: "turn" }> = {
  kind: "turn",
  id: "turn-user-1",
  multitasks: [],
  steerEvents: [],
  assistantEvents: [
    {
      id: "answer",
      sessionId: "session-a",
      type: "message.completed",
      message: "Done.",
      payload: {},
      createdAt: "2026-05-12T15:00:04.000Z"
    }
  ],
  toolItems: [{ kind: "tool", tool: edit }],
  assistantTimestamps: [Date.parse("2026-05-12T15:00:04.000Z")]
};

function renderTurn(
  overrides: {
    item?: Extract<RenderItem, { kind: "turn" }>;
    session?: SessionSummary;
    openRunAt?: string | null;
    defaultToolCallsDisplay?: ToolCallsDisplay;
    defaultToolCallGroupsExpanded?: boolean;
    thinkingDisplay?: ThinkingDisplay;
    todo?: TodoList | null;
    follow?: TranscriptFollow;
    onOpenAgent?: (tool: ToolCall) => void;
  } = {}
): { rerender: () => void; container: HTMLElement } {
  // A fresh `onOpenFile` per render is what SessionConversation itself hands
  // down, so the memo wrapper cannot bail out and the turn body really re-runs.
  const element = (): JSX.Element => (
    <SessionConversationTurn
      item={overrides.item ?? turn}
      priorItem={null}
      isLatestTurn
      openRunAt={overrides.openRunAt ?? null}
      session={overrides.session ?? session}
      workspace={null}
      onOpenFile={() => undefined}
      defaultToolCallsDisplay={overrides.defaultToolCallsDisplay}
      defaultToolCallGroupsExpanded={overrides.defaultToolCallGroupsExpanded}
      thinkingDisplay={overrides.thinkingDisplay}
      todo={overrides.todo}
      follow={overrides.follow}
      onOpenAgent={overrides.onOpenAgent}
    />
  );
  const result = render(element());
  return { rerender: () => result.rerender(element()), container: result.container };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  collectTurnFileChanges.mockClear();
});

describe("SessionConversationTurn", () => {
  it.each([1, 16])("shows a finished Minimal reply after %i steps without requiring scrolling", (steps) => {
    vi.useFakeTimers();
    let detached = false;
    const follow: TranscriptFollow = {
      isDetached: () => detached,
      newBelowCount: () => 0,
      subscribe: () => () => undefined
    };
    const toolItems = Array.from({ length: steps }, (_, index) => ({
      kind: "tool" as const,
      tool: { ...edit, id: `edit-${index}`, toolUseId: `edit-${index}`,
        createdAt: new Date(Date.parse(session.startedAt) + index * 2000 + 1000).toISOString() }
    }));
    const narration = toolItems.map((_, index) => ({
      ...turn.assistantEvents[0], id: `progress-${index}`, message: `Checking file ${index}.`,
      createdAt: new Date(Date.parse(session.startedAt) + index * 2000).toISOString()
    }));
    const options = {
      item: { ...turn, toolItems, assistantEvents: narration },
      session: { ...session, state: "running" as SessionSummary["state"] },
      defaultToolCallsDisplay: "single-line" as const,
      follow
    };
    const { rerender } = renderTurn(options);
    expect(screen.getAllByRole("button", { name: /Edited/ }).length).toBeGreaterThan(0);
    detached = true;
    options.item = { ...options.item, assistantEvents: [...narration, {
      ...turn.assistantEvents[0], createdAt: "2026-05-12T15:01:00.000Z",
      message: "The requested implementation is complete. All focused checks passed."
    }] };
    options.session = session;
    rerender();
    act(() => { vi.advanceTimersByTime(600); });
    expect(screen.queryByRole("button", { name: /Edited/ })).not.toBeInTheDocument();
    expect(screen.getByText("The requested implementation is complete. All focused checks passed.")).toBeVisible();
    expect(follow.isDetached()).toBe(true);
  });

  it.each([
    { hasPlan: true, hasAgent: false },
    { hasPlan: false, hasAgent: true },
    { hasPlan: false, hasAgent: false },
    { hasPlan: true, hasAgent: true }
  ])("renders connected activity in order with plan=$hasPlan and agent=$hasAgent", ({ hasPlan, hasAgent }) => {
    const item = hasAgent ? { ...turn, toolItems: [...turn.toolItems, { kind: "tool" as const, tool: agent }] } : turn;
    renderTurn({
      item,
      todo: hasPlan ? plan : null,
      onOpenAgent: () => undefined,
      defaultToolCallsDisplay: "collapsed",
      defaultToolCallGroupsExpanded: false
    });

    const activity = screen.getByRole("button", { name: "Edited a file" });
    const planGroup = screen.queryByRole("group", { name: "Plan" });
    const agentLaunch = screen.queryByRole("button", { name: /^Started agent / });
    const reply = screen.getByText("Done.");
    expect(Boolean(planGroup)).toBe(hasPlan);
    expect(Boolean(agentLaunch)).toBe(hasAgent);
    const timeline = [activity, agentLaunch, planGroup, reply].filter((node): node is HTMLElement => node !== null);
    for (let index = 1; index < timeline.length; index += 1) {
      expect(timeline[index - 1].compareDocumentPosition(timeline[index]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("preserves the reader's open activity and plan when the plan moves and a reply arrives", () => {
    const options = {
      item: turn,
      todo: plan,
      defaultToolCallsDisplay: "collapsed" as const,
      defaultToolCallGroupsExpanded: false,
      onOpenAgent: () => undefined
    };
    const { rerender } = renderTurn(options);
    const activity = screen.getByRole("button", { name: "Edited a file" });
    const planToggle = within(screen.getByRole("group", { name: "Plan" })).getByRole("button");
    fireEvent.click(activity);
    fireEvent.click(planToggle);
    expect(activity).toHaveAttribute("aria-expanded", "true");
    expect(planToggle).toHaveAttribute("aria-expanded", "true");

    options.item = {
      ...turn,
      toolItems: [...turn.toolItems, { kind: "tool", tool: agent }],
      assistantEvents: [...turn.assistantEvents, {
        id: "later-reply", sessionId: session.id, type: "message.completed" as const,
        message: "The agents finished.", payload: {}, createdAt: "2026-05-12T15:00:05.000Z"
      }]
    };
    options.todo = { ...plan, updatedAt: "2026-05-12T15:00:01.000Z" };
    rerender();

    expect(screen.getByRole("button", { name: "Edited a file" })).toBe(activity);
    expect(within(screen.getByRole("group", { name: "Plan" })).getByRole("button")).toBe(planToggle);
    expect(activity).toHaveAttribute("aria-expanded", "true");
    expect(planToggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /^Started agent / })).toBeInTheDocument();
    expect(screen.getByText("The agents finished.")).toBeInTheDocument();
  });

  it.each(["complete", "failed", "cancelled"] as const)(
    "settles a waiting turn when its session becomes %s",
    (state) => {
      vi.useFakeTimers();
      const options = {
        session: { ...session, state: "waiting" as SessionSummary["state"] },
        defaultToolCallsDisplay: "single-line" as const
      };
      const { rerender } = renderTurn(options);
      expect(screen.getByRole("button", { name: "Waiting" })).toBeInTheDocument();
      options.session = { ...options.session, state };
      rerender();
      act(() => { vi.advanceTimersByTime(600); });
      expect(screen.queryByRole("button", { name: "Waiting" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^Worked/ })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Edited/ })).not.toBeInTheDocument();
    }
  );

  it.each(["single-line", "collapsed"] as const)(
    "keeps %s activity open across a waiting pause and a later reply",
    (defaultToolCallsDisplay) => {
      vi.useFakeTimers();
      const options = {
        session: { ...session, state: "running" as SessionSummary["state"] },
        item: turn,
        defaultToolCallsDisplay
      };
      const { rerender } = renderTurn(options);
      const activity = screen.getByRole("button", { name: /Edited/ });
      expect(screen.getByRole("button", { name: "Working" })).toBeInTheDocument();

      options.session = { ...options.session, state: "waiting", attention: "approval-needed" };
      rerender();
      act(() => { vi.advanceTimersByTime(10000); });
      expect(activity).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Worked/ })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Waiting" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Copy reply" })).not.toBeInTheDocument();

      options.session = { ...options.session, state: "running", attention: "normal" };
      options.item = {
        ...turn,
        assistantEvents: [...turn.assistantEvents, {
          id: "late-answer", sessionId: session.id, type: "message.completed",
          message: "The approved operation has now finished.", payload: {},
          createdAt: "2026-05-12T15:00:20.000Z"
        }]
      };
      rerender();
      expect(screen.getByRole("button", { name: "Working" })).toBeInTheDocument();
      expect(screen.getByText(/The approved operation has now finished/)).toBeVisible();

      options.session = { ...options.session, state: "complete" };
      rerender();
      act(() => { vi.advanceTimersByTime(600); });
      expect(screen.getByRole("button", { name: /^Worked/ })).toBeInTheDocument();
      if (defaultToolCallsDisplay === "single-line") expect(activity).not.toBeInTheDocument();
    }
  );

  it("does not re-derive the turn's file changes when nothing about the turn changed", () => {
    // Every mounted turn used to re-run the whole render-state derivation on
    // each streaming delta: `buildTurnRenderState` returns a fresh
    // `hiddenToolIds` Set, which invalidated the visible-tools memo and with it
    // the changed-files fold, for every turn in the transcript.
    const { rerender } = renderTurn();
    expect(collectTurnFileChanges).toHaveBeenCalledTimes(1);

    rerender();
    rerender();

    expect(collectTurnFileChanges).toHaveBeenCalledTimes(1);
  });

  it("copies the reply, not the reasoning that produced it", () => {
    // "Copy reply" used to join the turn's raw events, which carry the
    // extended-thinking blocks and one row per streamed answer fragment.
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const thoughtfulTurn: Extract<RenderItem, { kind: "turn" }> = {
      ...turn,
      toolItems: [],
      assistantEvents: [
        {
          id: "think",
          sessionId: "session-a",
          type: "message.delta",
          message: "The user wants the file edited.",
          payload: { thinking: true },
          createdAt: "2026-05-12T15:00:01.000Z"
        },
        {
          id: "answer",
          sessionId: "session-a",
          type: "message.completed",
          message: "Done.",
          payload: {},
          createdAt: "2026-05-12T15:00:04.000Z"
        }
      ]
    };
    renderTurn({ item: thoughtfulTurn });

    fireEvent.click(screen.getByRole("button", { name: "Copy reply" }));

    expect(writeText).toHaveBeenCalledWith("Done.");
  });

  it("holds the changed-files card back while the transcript is ahead of a stale session row", () => {
    // A phone reads session state through a `dashboard:list` round trip while
    // transcript events arrive on their own feed, so the row can still say
    // "complete" from before the turn began. The card is a coda to a finished
    // turn, and used to appear mid-work with every file written so far.
    collectTurnFileChanges.mockReturnValue([
      { path: "src/app.ts", kind: "edit", adds: 1, dels: 1, writes: 1 }
    ] as never);

    const { container } = renderTurn({ openRunAt: "2026-05-12T15:00:12.000Z" });
    expect(container.querySelector(".turn-changes")).toBeNull();

    cleanup();
    // Once the run's closing marker lands the card is due, without waiting for
    // the row to catch up.
    const settled = renderTurn({ openRunAt: null });
    expect(settled.container.querySelector(".turn-changes")).not.toBeNull();

    collectTurnFileChanges.mockReturnValue([]);
  });

  it("shows a live thought in full, without the answer bubble's paced reveal", () => {
    // The thought streams (so MarkdownStream keeps the committed/tail split
    // instead of re-parsing the growing buffer per delta) but is not paced:
    // reasoning arrives in bursts that a typewriter would trail by seconds.
    vi.useFakeTimers();
    const thinking = "R".repeat(200);
    const liveTurn: Extract<RenderItem, { kind: "turn" }> = {
      ...turn,
      toolItems: [],
      assistantEvents: [
        {
          id: "think",
          sessionId: "session-a",
          type: "message.delta",
          message: thinking,
          payload: { thinking: true },
          createdAt: "2026-05-12T15:00:01.000Z"
        }
      ]
    };
    const { container } = renderTurn({
      item: liveTurn,
      session: { ...session, state: "running" }
    });

    expect(container.textContent).toContain(thinking);
    vi.useRealTimers();
  });

  it("groups alternating thoughts and tools around readable progress in Compact", () => {
    const editTwo = { ...edit, id: "edit-2", toolUseId: "edit-2", createdAt: "2026-05-12T15:00:04.000Z" };
    const editThree = { ...edit, id: "edit-3", toolUseId: "edit-3", createdAt: "2026-05-12T15:00:06.000Z" };
    const compactTurn: Extract<RenderItem, { kind: "turn" }> = {
      ...turn,
      toolItems: [
        { kind: "tool", tool: edit },
        { kind: "tool", tool: editTwo },
        { kind: "tool", tool: editThree }
      ],
      assistantEvents: [
        {
          id: "thought-1",
          sessionId: "session-a",
          type: "message.delta",
          message: "Inspecting the repository.",
          payload: { thinking: true },
          createdAt: "2026-05-12T15:00:01.000Z"
        },
        {
          id: "thought-2",
          sessionId: "session-a",
          type: "message.delta",
          message: "Checking the relevant files.",
          payload: { thinking: true },
          createdAt: "2026-05-12T15:00:03.000Z"
        },
        {
          id: "progress",
          sessionId: "session-a",
          type: "message.completed",
          message: "I found the mismatch.",
          payload: {},
          createdAt: "2026-05-12T15:00:05.000Z"
        },
        {
          id: "thought-3",
          sessionId: "session-a",
          type: "message.delta",
          message: "Planning the smallest fix.",
          payload: { thinking: true },
          createdAt: "2026-05-12T15:00:07.000Z"
        }
      ],
      assistantTimestamps: [
        Date.parse("2026-05-12T15:00:01.000Z"),
        Date.parse("2026-05-12T15:00:03.000Z"),
        Date.parse("2026-05-12T15:00:05.000Z"),
        Date.parse("2026-05-12T15:00:07.000Z")
      ]
    };

    renderTurn({
      item: compactTurn,
      defaultToolCallsDisplay: "collapsed",
      defaultToolCallGroupsExpanded: false,
      thinkingDisplay: "collapsed"
    });

    expect(screen.getByText("I found the mismatch.")).toBeInTheDocument();
    const activityGroups = screen.getAllByRole("button", { name: /^Edited/ });
    expect(activityGroups).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Thought" })).toBeNull();

    fireEvent.click(activityGroups[0]);

    expect(screen.getAllByRole("button", { name: "Thought" })).toHaveLength(2);
  });

  it("keeps a thought-only Compact activity run connected to the turn chip", () => {
    const thoughtOnlyTurn: Extract<RenderItem, { kind: "turn" }> = {
      ...turn,
      toolItems: [],
      assistantEvents: [
        {
          id: "thought-only",
          sessionId: "session-a",
          type: "message.delta",
          message: "Reviewing the request.",
          payload: { thinking: true },
          createdAt: "2026-05-12T15:00:01.000Z"
        }
      ],
      assistantTimestamps: [Date.parse("2026-05-12T15:00:01.000Z")]
    };

    renderTurn({
      item: thoughtOnlyTurn,
      defaultToolCallsDisplay: "collapsed",
      defaultToolCallGroupsExpanded: false,
      thinkingDisplay: "collapsed"
    });

    const chip = screen.getByRole("button", { name: /^Worked/ });
    expect(chip).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("button", { name: "Thought" })).toHaveLength(1);
    expect(screen.getByText("Reviewing the request.")).toBeInTheDocument();
  });

  it("opens thought-only turns independently", () => {
    const firstTurn: Extract<RenderItem, { kind: "turn" }> = {
      ...turn,
      id: "turn-thought-1",
      toolItems: [],
      assistantEvents: [
        {
          id: "thought-1",
          sessionId: "session-a",
          type: "message.delta",
          message: "Reviewing the first request.",
          payload: { thinking: true },
          createdAt: "2026-05-12T15:00:01.000Z"
        }
      ]
    };
    const secondTurn: Extract<RenderItem, { kind: "turn" }> = {
      ...firstTurn,
      id: "turn-thought-2",
      assistantEvents: [
        {
          ...firstTurn.assistantEvents[0],
          id: "thought-2",
          message: "Reviewing the second request."
        }
      ]
    };

    renderTurn({
      item: firstTurn,
      defaultToolCallsDisplay: "collapsed",
      defaultToolCallGroupsExpanded: false,
      thinkingDisplay: "collapsed"
    });
    renderTurn({
      item: secondTurn,
      defaultToolCallsDisplay: "collapsed",
      defaultToolCallGroupsExpanded: false,
      thinkingDisplay: "collapsed"
    });

    const disclosures = screen.getAllByRole("button", { name: "Thought" });
    expect(disclosures).toHaveLength(2);
    fireEvent.click(disclosures[0]);
    expect(within(disclosures[0]).queryByText("Reviewing the first request.")).toBeNull();
    expect(screen.getByText("Reviewing the first request.")).toBeInTheDocument();
    // The other turn's thought stays folded to its one-line excerpt.
    expect(within(disclosures[1]).getByText("Reviewing the second request.")).toBeInTheDocument();
    fireEvent.click(disclosures[1]);
    expect(within(disclosures[1]).queryByText("Reviewing the second request.")).toBeNull();
    expect(screen.getByText("Reviewing the second request.")).toBeInTheDocument();
  });
});
