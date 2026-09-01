import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionSummary } from "../../shared/types.js";
import { ContextRing } from "./ContextRing.js";

const base: SessionSummary = {
  id: "s1",
  workspaceId: "w1",
  provider: "codex",
  modelLabel: "GPT-5.6 Sol",
  modelId: "gpt-5.6-sol",
  permissionMode: "auto-approve",
  providerConversationId: null,
  prompt: "Do the thing",
  state: "running",
  attention: "normal",
  startedAt: "2026-07-01T00:00:00.000Z",
  completedAt: null,
  lastActivityAt: "2026-07-01T00:00:00.000Z"
};

afterEach(cleanup);

describe("ContextRing", () => {
  it("renders nothing when the window is unknown", () => {
    const { container } = render(
      <ContextRing session={{ ...base, modelId: "mystery-model", contextTokens: 100, contextWindow: null }} />
    );
    expect(container.firstChild).toBeNull();
  });

  // Codex reports its window only on `token_count` rows, which `codex exec
  // --json` no longer emits, so it falls back to the model table like every
  // other provider. Occupancy past the window still pins the dial at full
  // rather than overrunning it.
  it("falls back to the model table for Codex, clamping occupancy at full", () => {
    render(<ContextRing session={{ ...base, contextTokens: 501468, contextWindow: null }} />);
    expect(screen.getByRole("button", { name: /Context window 100% full/ })).toBeTruthy();
  });

  it("renders nothing before any context is used", () => {
    const { container } = render(<ContextRing session={{ ...base, contextTokens: 0, contextWindow: 258000 }} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows percent full from the reported window and opens a detailed popover", () => {
    render(<ContextRing session={{ ...base, contextTokens: 204000, contextWindow: 258000 }} />);
    // The chip is just the ring — the percent lives in its accessible label and
    // the popover, not as visible text next to it.
    const trigger = screen.getByRole("button", { name: /Context window 79% full/ });

    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Context window usage" });
    // Headroom first, detail second — the percentage and the exact counts stay
    // on the trigger's label, where they don't compete with the answer.
    expect(dialog).toHaveTextContent("54k left");
    expect(dialog).toHaveTextContent("204k of 258k used");
  });

  it("falls back to the per-model table when the provider reports no window", () => {
    render(
      <ContextRing
        session={{ ...base, provider: "claude", modelId: "claude-opus-5", contextTokens: 100000, contextWindow: null }}
      />
    );
    // Opus 5's 1M table entry → 100000 / 1000000 = 10%.
    expect(screen.getByRole("button", { name: /Context window 10% full/ })).toBeInTheDocument();
  });
});
