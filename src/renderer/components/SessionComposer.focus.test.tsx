import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { baseSession, event, renderConversation, rerenderConversation } from "../../test/sessionConversationTestHarness.js";

const questionEvents = [
  event("user", "user.message", "Investigate", "2026-05-12T15:30:00.000Z"),
  event("question", "command.started", "AskUserQuestion", "2026-05-12T15:31:00.000Z", {
    type: "tool_use", id: "question-one", name: "AskUserQuestion",
    input: { questions: [{
      question: "Pick a direction", header: "Direction", multiSelect: false,
      options: [{ label: "Fix findings" }, { label: "General maintenance" }]
    }] }
  })
];

describe("SessionComposer focus during background updates", () => {
  afterEach(cleanup);

  it("does not steal a neighboring draft when an unfocused pane mounts", () => {
    const neighborView = render(<textarea aria-label="Neighbor draft" />);
    const neighbor = within(neighborView.container).getByRole<HTMLTextAreaElement>("textbox", {
      name: "Neighbor draft"
    });
    neighbor.focus();

    // Mount another background pane after the reader has started typing. Its
    // composer must not claim focus merely because its input became available.
    const background = renderConversation(baseSession({ id: "session-b" }), [], {
      isFocused: false
    });

    expect(within(background.container).getByRole("textbox", { name: "Chat prompt" })).not.toHaveFocus();
    expect(neighbor).toHaveFocus();
  });

  it("focuses the composer when its pane becomes active", () => {
    const options = { isFocused: false };
    const { rerender } = renderConversation(baseSession(), [], options);
    const prompt = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Chat prompt" });
    const neighborView = render(<textarea aria-label="Neighbor draft" />);
    const neighbor = within(neighborView.container).getByRole<HTMLTextAreaElement>("textbox", {
      name: "Neighbor draft"
    });
    neighbor.focus();

    rerenderConversation(rerender, baseSession(), [], { isFocused: true });

    expect(prompt).toHaveFocus();
  });

  it("docks an arriving question in an unfocused pane without stealing the neighboring draft", () => {
    const session = baseSession({ provider: "claude", state: "running" });
    const first = renderConversation(session);
    const second = renderConversation(baseSession({ id: "session-b" }));
    const neighbor = within(second.container).getByRole<HTMLTextAreaElement>("textbox", { name: "Chat prompt" });
    act(() => neighbor.focus());
    fireEvent.change(neighbor, { target: { value: "Keep writing" } });
    neighbor.setSelectionRange(2, 4);
    rerenderConversation(first.rerender, session, questionEvents);
    expect(within(first.container).queryByRole("textbox", { name: "Chat prompt" })).not.toBeInTheDocument();
    expect(within(first.container).getByRole("button", { name: "Answer in your own words" })).toBeInTheDocument();
    expect(neighbor).toHaveFocus();
    expect(neighbor.selectionStart).toBe(2);
    expect(neighbor.selectionEnd).toBe(4);
  });

  it("keeps the focused draft when an agent question arrives and can answer inline", async () => {
    const session = baseSession({ provider: "claude", state: "running" });
    const onSendSessionInput = vi.fn().mockResolvedValue(undefined);
    const options = { onSendSessionInput };
    const { rerender } = renderConversation(session, [], options);
    const prompt = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Chat prompt" });
    prompt.focus();
    fireEvent.change(prompt, { target: { value: "A follow-up in progress" } });
    prompt.setSelectionRange(5, 9);
    rerenderConversation(rerender, session, questionEvents, options);
    expect(screen.getByText("Pick a direction")).toBeInTheDocument();
    expect(prompt).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Chat prompt" })).toBe(prompt);
    expect(prompt).toHaveFocus();
    expect(prompt).toBeEnabled();
    expect(prompt).toHaveValue("A follow-up in progress");
    expect(prompt.selectionStart).toBe(5);
    expect(prompt.selectionEnd).toBe(9);
    const questionOptions = screen.getByRole("listbox", { name: "Direction" });
    act(() => questionOptions.focus());
    rerenderConversation(rerender, baseSession({ ...session, state: "complete" }), questionEvents, options);
    expect(screen.getByRole("textbox", { name: "Chat prompt" })).toBe(prompt);
    expect(questionOptions).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Answer in your own words" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: /Fix findings/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
    await waitFor(() => {
      expect(onSendSessionInput).toHaveBeenCalledWith(session.id, "**Direction**: Fix findings", expect.anything(), "auto", undefined);
    });
    expect(prompt).toHaveValue("A follow-up in progress");
  });

  it("restores focus after sending when the reader has not moved elsewhere", async () => {
    let resolveSend!: () => void;
    const sendComplete = new Promise<void>((resolve) => { resolveSend = resolve; });
    renderConversation(baseSession({ state: "running" }), [], {
      onSendSessionInput: () => sendComplete
    });
    const prompt = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Chat prompt" });
    expect(prompt).toHaveFocus();
    fireEvent.change(prompt, { target: { value: "Send this follow-up" } });
    // Model the browser's blur on disable before jsdom makes blur a no-op.
    prompt.blur();
    fireEvent.keyDown(prompt, { key: "Enter" });
    expect(prompt).toBeDisabled();
    expect(document.body).toHaveFocus();
    await act(async () => { resolveSend(); await sendComplete; });
    expect(prompt).toBeEnabled();
    expect(prompt).toHaveFocus();
  });

  it("keeps a neighboring composer focused when a delayed send completes", async () => {
    let resolveSend!: () => void;
    const sendComplete = new Promise<void>((resolve) => { resolveSend = resolve; });
    const first = renderConversation(baseSession({ state: "running" }), [], {
      onSendSessionInput: () => sendComplete
    });
    const prompt = within(first.container).getByRole("textbox", { name: "Chat prompt" });
    fireEvent.change(prompt, { target: { value: "Send this follow-up" } });
    fireEvent.keyDown(prompt, { key: "Enter" });
    expect(prompt).toBeDisabled();

    const second = renderConversation(baseSession({ id: "session-b" }));
    const neighbor = within(second.container).getByRole<HTMLTextAreaElement>("textbox", { name: "Chat prompt" });
    neighbor.focus();
    fireEvent.change(neighbor, { target: { value: "Still writing here" } });
    neighbor.setSelectionRange(5, 5);
    await act(async () => { resolveSend(); await sendComplete; });

    expect(prompt).toBeEnabled();
    expect(neighbor).toHaveFocus();
    expect(neighbor.selectionStart).toBe(5);
  });

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
