import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { baseSession, event, renderConversation } from "../../test/sessionConversationTestHarness.js";

describe("SessionComposer picker shortcuts", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(cleanup);

  it("opens the model picker on ⌘⇧M and the effort picker on ⌘⇧E for the focused pane", () => {
    renderConversation(baseSession({ state: "complete", provider: "claude" }));
    const prompt = screen.getByRole("textbox", { name: "Chat prompt" });

    fireEvent.keyDown(prompt, { key: "M", metaKey: true, shiftKey: true });
    expect(screen.getByRole("listbox", { name: "Chat model" })).toBeInTheDocument();

    fireEvent.keyDown(prompt, { key: "M", metaKey: true, shiftKey: true });
    expect(screen.queryByRole("listbox", { name: "Chat model" })).toBeNull();

    fireEvent.keyDown(prompt, { key: "E", metaKey: true, shiftKey: true });
    expect(screen.getByRole("slider", { name: "Reasoning effort" })).toHaveFocus();
  });

  it("stays quiet in a pane that is not focused", () => {
    renderConversation(baseSession({ state: "complete", provider: "claude" }), [], { isFocused: false });

    fireEvent.keyDown(document, { key: "M", metaKey: true, shiftKey: true });
    expect(screen.queryByRole("listbox", { name: "Chat model" })).toBeNull();
  });

  it("recalls the last sent message on ⌘↑ only while the draft is empty", () => {
    renderConversation(baseSession({ state: "complete" }), [
      event("user-1", "user.message", "First ask", "2026-05-12T15:30:00.000Z"),
      event("user-2", "user.message", "Second ask", "2026-05-12T15:40:00.000Z")
    ]);
    const prompt = screen.getByRole("textbox", { name: "Chat prompt" });

    fireEvent.keyDown(prompt, { key: "ArrowUp", metaKey: true });
    expect(prompt).toHaveValue("Second ask");

    fireEvent.change(prompt, { target: { value: "typing" } });
    fireEvent.keyDown(prompt, { key: "ArrowUp", metaKey: true });
    expect(prompt).toHaveValue("typing");
  });
});
