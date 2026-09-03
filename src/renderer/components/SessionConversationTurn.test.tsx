import { cleanup, render } from "@testing-library/react";
import { createRef, type JSX } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../../shared/types.js";
import type { RenderItem } from "../lib/foldConversation.js";
import type { ModelPickerSelection } from "../lib/models.js";
import type { ToolCall } from "../lib/toolCalls.js";

const collectTurnFileChanges = vi.hoisted(() => vi.fn(() => []));

vi.mock("../lib/turnFileChanges.js", () => ({ collectTurnFileChanges }));

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
  lastActivityAt: "2026-05-12T15:00:09.000Z"
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
  overrides: { item?: Extract<RenderItem, { kind: "turn" }>; session?: SessionSummary } = {}
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
