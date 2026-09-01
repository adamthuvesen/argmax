import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { baseSession, renderConversation } from "../../test/sessionConversationTestHarness.js";

const STATIC_PLACEHOLDER = "Reply to your agent, or @-mention files";

/**
 * A partial `window.argmax` crashes the pane — sibling components (the actions
 * menu, the model pickers) reach for their own namespaces on mount. So every
 * path but `session.suggestFollowUp` resolves to an empty list.
 */
function stubSuggestion(
  suggestFollowUp: (input: unknown) => Promise<{ suggestion: string | null }>
): void {
  const anything: object = new Proxy(() => Promise.resolve([]), {
    get: (): unknown => anything,
    apply: (): unknown => Promise.resolve([])
  });
  const withFallback = (target: object): object =>
    new Proxy(target, {
      get: (own, key): unknown =>
        key in own ? (own as Record<string | symbol, unknown>)[key] : anything
    });
  window.argmax = withFallback({
    session: withFallback({ suggestFollowUp })
  }) as typeof window.argmax;
}

describe("SessionComposer follow-up suggestion", () => {
  afterEach(() => {
    cleanup();
    delete window.argmax;
  });

  it("offers the agent's suggested reply as the placeholder once the turn ends", async () => {
    const suggestFollowUp = vi.fn(() =>
      Promise.resolve({ suggestion: "Add a test for the empty case" })
    );
    stubSuggestion(suggestFollowUp);

    renderConversation(baseSession({ state: "complete" }));

    await waitFor(() => {
      expect(screen.getByPlaceholderText("Add a test for the empty case")).toBeTruthy();
    });
    expect(suggestFollowUp).toHaveBeenCalledWith({
      sessionId: "session-a",
      provider: "codex",
      // The cheap title model, not the session's own — a placeholder is a
      // handful of tokens and must not queue behind an expensive model.
      modelId: "gpt-5.6-luna"
    });
  });

  it("keeps the static placeholder while the agent is still working", () => {
    const suggestFollowUp = vi.fn(() => Promise.resolve({ suggestion: "never asked" }));
    stubSuggestion(suggestFollowUp);

    renderConversation(baseSession({ state: "running" }));

    expect(screen.queryByPlaceholderText("never asked")).toBeNull();
    expect(suggestFollowUp).not.toHaveBeenCalled();
  });

  it("keeps the static placeholder when the helper model has nothing to offer", async () => {
    stubSuggestion(() => Promise.resolve({ suggestion: null }));

    renderConversation(baseSession({ state: "complete" }));

    await waitFor(() => {
      expect(screen.getByPlaceholderText(STATIC_PLACEHOLDER)).toBeTruthy();
    });
  });

  it("keeps the static placeholder when the helper call fails", async () => {
    stubSuggestion(() => Promise.reject(new Error("cli missing")));

    renderConversation(baseSession({ state: "complete" }));

    await waitFor(() => {
      expect(screen.getByPlaceholderText(STATIC_PLACEHOLDER)).toBeTruthy();
    });
  });
});
