import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { baseSession, renderConversation } from "../../test/sessionConversationTestHarness.js";

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
});
