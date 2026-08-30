import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  baseSession,
  renderConversation,
  rerenderConversation
} from "../../test/sessionConversationTestHarness.js";
import type { NewSessionSeed } from "./SessionComposer.js";

/** Open the idle session's picker and choose a model by its label. */
function pickModel(label: string): void {
  fireEvent.click(screen.getByRole("button", { name: "Session model" }));
  fireEvent.click(
    within(screen.getByRole("listbox", { name: "Session model" })).getByRole("button", { name: label })
  );
}

// The session is Codex; "Sonnet 5" belongs to Claude, so picking it crosses
// providers. A same-provider model change must not raise the dialog at all.
describe("SessionComposer provider switch confirmation", () => {
  afterEach(cleanup);

  it("holds a cross-provider pick behind a confirmation instead of applying it", () => {
    renderConversation(baseSession({ state: "complete", provider: "codex" }));

    pickModel("Sonnet 5");

    expect(screen.getByRole("dialog", { name: "Switch this session to Claude" })).toBeTruthy();
    // The chip still names the session's own provider until the user commits.
    expect(screen.getByRole("button", { name: "Session model" }).textContent).not.toContain("Sonnet 5");
  });

  // The overlay is `position: absolute; inset: 0`, so it fills whichever
  // positioned ancestor it lands in. The composer's own `.session-input` is
  // `position: relative`, so a dialog left there sizes to the input box and
  // spills over it instead of centring on the session.
  it("centres the dialog on the session pane, not the composer", () => {
    renderConversation(baseSession({ state: "complete", provider: "codex" }));

    pickModel("Sonnet 5");

    const dialog = screen.getByRole("dialog", { name: "Switch this session to Claude" });
    expect(dialog.closest(".session-input")).toBeNull();
    expect(dialog.parentElement).toHaveClass("conversation-surface");
  });

  it("applies the pick when the user switches anyway", () => {
    renderConversation(baseSession({ state: "complete", provider: "codex" }));

    pickModel("Sonnet 5");
    fireEvent.click(screen.getByRole("button", { name: "Switch anyway" }));

    expect(screen.queryByRole("dialog", { name: "Switch this session to Claude" })).toBeNull();
    expect(screen.getByRole("button", { name: "Session model" }).textContent).toContain("Sonnet 5");
  });

  it("keeps the current provider when the user cancels", () => {
    renderConversation(baseSession({ state: "complete", provider: "codex" }));

    pickModel("Sonnet 5");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog", { name: "Switch this session to Claude" })).toBeNull();
    expect(screen.getByRole("button", { name: "Session model" }).textContent).not.toContain("Sonnet 5");
  });

  it("hands the picked model and the half-written follow-up to a new session", () => {
    const onNewSession = vi.fn();
    renderConversation(baseSession({ state: "complete", provider: "codex" }), [], { onNewSession });

    fireEvent.change(screen.getByRole("textbox", { name: "Session prompt" }), {
      target: { value: "Try the other agent on this" }
    });
    pickModel("Sonnet 5");
    fireEvent.click(screen.getByRole("button", { name: "New session" }));

    expect(onNewSession).toHaveBeenCalledTimes(1);
    const seed = onNewSession.mock.calls[0]?.[0] as NewSessionSeed;
    expect(seed.model.provider).toBe("claude");
    expect(seed.model.label).toBe("Sonnet 5");
    expect(seed.prompt).toBe("Try the other agent on this");
    // The draft moved rather than being copied: it must not still be offered here.
    expect(screen.getByRole("textbox", { name: "Session prompt" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "Session model" }).textContent).not.toContain("Sonnet 5");
  });

  // `session.provider` stays on the old provider until the backend relaunches
  // on the next send, so the staged selection is what says the switch was
  // already confirmed. Without it, every later effort change re-raises the
  // dialog — and its early return drops the effort change on the floor.
  it("keeps the dialog closed when the effort changes after a confirmed switch", () => {
    renderConversation(baseSession({ state: "complete", provider: "codex" }));

    pickModel("Sonnet 5");
    fireEvent.click(screen.getByRole("button", { name: "Switch anyway" }));

    const effortLabelBefore = screen.getByRole("button", { name: "Session model effort" }).textContent;
    fireEvent.click(screen.getByRole("button", { name: "Session model effort" }));
    fireEvent.keyDown(screen.getByRole("slider", { name: "Reasoning effort" }), { key: "ArrowLeft" });
    fireEvent.click(screen.getByRole("button", { name: "Session model effort" }));

    expect(screen.queryByRole("dialog", { name: "Switch this session to Claude" })).toBeNull();
    expect(screen.getByRole("button", { name: "Session model effort" }).textContent).not.toBe(
      effortLabelBefore
    );
  });

  it("drops the held pick when a turn starts, since the send would only queue", () => {
    const { rerender } = renderConversation(baseSession({ state: "complete", provider: "codex" }));

    pickModel("Sonnet 5");
    expect(screen.getByRole("dialog", { name: "Switch this session to Claude" })).toBeTruthy();

    rerenderConversation(rerender, baseSession({ state: "running", provider: "codex" }));

    expect(screen.queryByRole("dialog", { name: "Switch this session to Claude" })).toBeNull();
  });

  it("drops the new-session action when the pane cannot open the launcher", () => {
    renderConversation(baseSession({ state: "complete", provider: "codex" }));

    pickModel("Sonnet 5");

    expect(screen.queryByRole("button", { name: "New session" })).toBeNull();
  });
});
