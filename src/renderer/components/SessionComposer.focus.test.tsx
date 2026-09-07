import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { baseSession, event, renderConversation, rerenderConversation } from "../../test/sessionConversationTestHarness.js";

describe("SessionComposer focus during background updates", () => {
  afterEach(cleanup);

  it("keeps the focused prompt and caret while output arrives and the turn finishes", () => {
    const { rerender } = renderConversation(baseSession({ state: "running" }));
    const prompt = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Chat prompt" });
    prompt.focus();
    fireEvent.change(prompt, { target: { value: "A follow-up in progress" } });
    prompt.setSelectionRange(5, 5);
    const events = [event("reply", "assistant_message", "Working on it", "2026-05-12T15:31:00.000Z")];
    for (const state of ["running", "complete"] as const) {
      rerenderConversation(rerender, baseSession({ state }), events);
      expect(screen.getByRole("textbox", { name: "Chat prompt" })).toBe(prompt);
      expect(prompt).toHaveFocus();
      expect(prompt).toBeEnabled();
      expect(prompt.selectionStart).toBe(5);
    }
  });
});
