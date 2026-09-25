import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { JSX } from "react";
import type { SessionSummary } from "../../shared/types.js";
import type { TerminateSessionOptions } from "../hooks/useSessionCommands.js";
import { baseSession } from "../../test/sessionConversationTestHarness.js";
import { ESCAPE_STOPS_CHAT_KEY } from "../lib/uiPreferences.js";
import { SessionPane } from "./SessionPane.js";

type TerminateSession = (sessionId: string, options?: TerminateSessionOptions) => Promise<void>;

interface PaneOptions {
  session?: SessionSummary;
  isFocused?: boolean;
  onTerminateSession?: Mock<TerminateSession>;
}

function pane({
  session = baseSession({ state: "running" }),
  isFocused = true,
  onTerminateSession = vi.fn<TerminateSession>().mockResolvedValue(undefined)
}: PaneOptions = {}): JSX.Element {
  return (
    <SessionPane
      approvals={[]}
      isFocused={isFocused}
      onResolveApproval={vi.fn().mockResolvedValue(undefined)}
      onSendSessionInput={vi.fn().mockResolvedValue(undefined)}
      onCancelQueuedMessage={vi.fn().mockResolvedValue(undefined)}
      onSendQueuedMessageNow={vi.fn().mockResolvedValue(undefined)}
      onTerminateSession={onTerminateSession}
      onClearSession={vi.fn().mockResolvedValue(undefined)}
      project={null}
      session={session}
      workspace={null}
    />
  );
}

function renderPane({
  session = baseSession({ state: "running" }),
  isFocused = true,
  onTerminateSession = vi.fn<TerminateSession>().mockResolvedValue(undefined)
}: PaneOptions = {}): Mock<TerminateSession> {
  render(pane({ session, isFocused, onTerminateSession }));
  return onTerminateSession;
}

describe("SessionPane Escape", () => {
  beforeEach(() => {
    window.localStorage.setItem(ESCAPE_STOPS_CHAT_KEY, "true");
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("stops the focused running chat from its composer", () => {
    const terminate = renderPane();
    fireEvent.keyDown(screen.getByLabelText("Chat prompt"), { key: "Escape" });
    expect(terminate).toHaveBeenCalledExactlyOnceWith("session-a");
  });

  it("ignores repeated, composing, and modified Escape", () => {
    const terminate = renderPane();
    const prompt = screen.getByLabelText("Chat prompt");
    const consumed = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    consumed.preventDefault();
    prompt.dispatchEvent(consumed);
    fireEvent.keyDown(prompt, { key: "Escape", repeat: true });
    fireEvent.keyDown(prompt, { key: "Escape", isComposing: true });
    fireEvent.keyDown(prompt, { key: "Escape", shiftKey: true });
    expect(terminate).not.toHaveBeenCalled();
  });

  it.each(["cm-editor", "xterm"])("leaves Escape with a focused %s surface", (className) => {
    const terminate = renderPane();
    const editor = document.createElement("div");
    editor.className = className;
    const input = document.createElement("textarea");
    editor.appendChild(input);
    document.body.appendChild(editor);
    try {
      fireEvent.keyDown(input, { key: "Escape" });
      expect(terminate).not.toHaveBeenCalled();
    } finally {
      editor.remove();
    }
  });

  it("does not stop an inactive or already-stopped chat", () => {
    const inactiveTerminate = renderPane({ isFocused: false });
    fireEvent.keyDown(screen.getByLabelText("Chat prompt"), { key: "Escape" });
    expect(inactiveTerminate).not.toHaveBeenCalled();
    cleanup();

    const stoppedTerminate = renderPane({ session: baseSession({ state: "complete" }) });
    fireEvent.keyDown(screen.getByLabelText("Chat prompt"), { key: "Escape" });
    expect(stoppedTerminate).not.toHaveBeenCalled();
  });

  it("does not send a second termination while the first is pending", () => {
    let resolveTermination: (() => void) | undefined;
    const terminate = vi.fn<TerminateSession>(() => new Promise<void>((resolve) => {
      resolveTermination = resolve;
    }));
    renderPane({ onTerminateSession: terminate });
    const prompt = screen.getByLabelText("Chat prompt");
    fireEvent.keyDown(prompt, { key: "Escape" });
    fireEvent.keyDown(prompt, { key: "Escape" });
    expect(terminate).toHaveBeenCalledTimes(1);
    resolveTermination?.();
  });

  it("does not let an earlier session's completion clear the current pending stop", async () => {
    const resolvers = new Map<string, () => void>();
    const terminate = vi.fn<TerminateSession>((sessionId) => new Promise<void>((resolve) => {
      resolvers.set(sessionId, resolve);
    }));
    const { rerender } = render(pane({
      session: baseSession({ id: "session-a", state: "running" }),
      onTerminateSession: terminate
    }));
    const prompt = screen.getByLabelText("Chat prompt");
    fireEvent.keyDown(prompt, { key: "Escape" });

    rerender(pane({
      session: baseSession({ id: "session-b", state: "running" }),
      onTerminateSession: terminate
    }));
    fireEvent.keyDown(screen.getByLabelText("Chat prompt"), { key: "Escape" });
    await act(async () => {
      resolvers.get("session-a")?.();
      await Promise.resolve();
    });
    fireEvent.keyDown(screen.getByLabelText("Chat prompt"), { key: "Escape" });

    expect(terminate.mock.calls.map(([sessionId]) => sessionId)).toEqual(["session-a", "session-b"]);
    resolvers.get("session-b")?.();
  });

  it("does not stop through a dialog that keeps Escape while busy", () => {
    const terminate = renderPane();
    const dialog = document.createElement("section");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    try {
      fireEvent.keyDown(screen.getByLabelText("Chat prompt"), { key: "Escape" });
      expect(terminate).not.toHaveBeenCalled();
    } finally {
      dialog.remove();
    }
  });
});
