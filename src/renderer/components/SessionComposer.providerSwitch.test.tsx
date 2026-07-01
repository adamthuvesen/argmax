import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { baseSession, renderConversation } from "../../test/sessionConversationTestHarness.js";

describe("SessionComposer — provider switching", () => {
  afterEach(() => {
    cleanup();
  });

  it("offers a cross-provider picker on an idle session", () => {
    // Idle composer exposes every provider, so the next turn can hand off to a
    // different agent. The cross-provider picker groups options by provider.
    renderConversation(baseSession({ provider: "codex", state: "complete" }));
    fireEvent.click(screen.getByRole("button", { name: "Session model" }));

    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getByText("Cursor")).toBeInTheDocument();
  });

  it("locks the picker to the session provider while a turn is running", () => {
    // Mid-turn the message queues, so provider can't change yet — only the
    // session provider's own models are offered (no provider group headers).
    renderConversation(baseSession({ provider: "codex", state: "running" }));
    fireEvent.click(screen.getByRole("button", { name: "Session model" }));

    expect(screen.queryByText("Claude")).not.toBeInTheDocument();
    expect(screen.queryByText("Cursor")).not.toBeInTheDocument();
  });
});
