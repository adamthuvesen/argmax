import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef, type JSX } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../../shared/types.js";
import type { RenderItem } from "../lib/foldConversation.js";
import type { ModelPickerSelection } from "../lib/models.js";
import type { ToolCall } from "../lib/toolCalls.js";
import type * as TurnFileChanges from "../lib/turnFileChanges.js";

const collectTurnFileChanges = vi.hoisted(() => vi.fn(() => []));

// Only the collector is stubbed — it is what this file counts calls to. The
// rest of the module stays real so the turn keeps summing its own changes.
vi.mock("../lib/turnFileChanges.js", async (importOriginal) => ({
  ...(await importOriginal<typeof TurnFileChanges>()),
  collectTurnFileChanges
}));

const { SessionConversationTurn } = await import("./SessionConversationTurn.js");

const MODEL: ModelPickerSelection = {
  provider: "claude",
  modelId: "claude-sonnet-5",
  label: "Sonnet 5",
  reasoningEffort: "medium"
};

const session: SessionSummary = {
  id: "session-a",
  workspaceId: "workspace-1",
  provider: "claude",
  modelLabel: "Sonnet 5",
  modelId: "claude-sonnet-5",
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
  } = {}
): { rerender: () => void; container: HTMLElement } {
  const inputRef = createRef<HTMLTextAreaElement>();
  const shouldRefocusInput = { current: false };
  // A fresh `onOpenFile` per render is what SessionConversation itself hands
  // down, so the memo wrapper cannot bail out and the turn body really re-runs.
  const element = (): JSX.Element => (
    <SessionConversationTurn
      item={overrides.item ?? turn}
      priorItem={null}
      isLatestTurn
      openRunAt={overrides.openRunAt ?? null}
      session={overrides.session ?? session}
      selectedModel={MODEL}
      workspace={null}
      onOpenFile={() => undefined}
      onTerminateSession={() => Promise.resolve(undefined)}
      onSendSessionInput={() => Promise.resolve(undefined)}
      inputRef={inputRef}
      shouldRefocusInput={shouldRefocusInput}
      setStatus={() => undefined}
      setAgentMode={() => undefined}
    />
  );
  const result = render(element());
  return { rerender: () => result.rerender(element()), container: result.container };
}

afterEach(() => {
  cleanup();
  collectTurnFileChanges.mockClear();
});

describe("SessionConversationTurn", () => {
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
});
