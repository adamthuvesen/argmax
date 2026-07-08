import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { baseSession, renderConversation } from "../../test/sessionConversationTestHarness.js";

describe("SessionComposer — provider switching", () => {
  afterEach(() => {
    cleanup();
  });

  it("offers a cross-provider picker on an idle session", () => {
    // Idle composer exposes every provider, so the next turn can hand off to a
    // different agent. The cross-provider picker lists all providers' models,
    // separated by thin dividers.
    renderConversation(baseSession({ provider: "codex", state: "complete" }));
    fireEvent.click(screen.getByRole("button", { name: "Session model" }));

    const list = screen.getByRole("listbox", { name: "Session model" });
    expect(within(list).getByText("Opus 4.8")).toBeInTheDocument(); // a Claude model
    expect(within(list).getByText("Claude Opus 4.8 (Cursor)")).toBeInTheDocument(); // a Cursor model
    expect(within(list).getAllByRole("separator").length).toBeGreaterThanOrEqual(2);
  });

  it("locks the picker to the session provider while a turn is running", () => {
    // Mid-turn the message queues, so provider can't change yet — only the
    // session provider's own models are offered, no other-provider rows.
    renderConversation(baseSession({ provider: "codex", state: "running" }));
    fireEvent.click(screen.getByRole("button", { name: "Session model" }));

    const list = screen.getByRole("listbox", { name: "Session model" });
    expect(within(list).queryByText("Opus 4.8")).not.toBeInTheDocument();
    expect(within(list).queryByText("Claude Opus 4.8 (Cursor)")).not.toBeInTheDocument();
  });
});
