import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingMessage } from "../../shared/types.js";
import { baseSession, renderConversation } from "../../test/sessionConversationTestHarness.js";

function prompt(): HTMLTextAreaElement {
  return screen.getByLabelText("Chat prompt");
}

const queued: PendingMessage[] = [
  {
    id: "pending-1",
    sessionId: "session-a",
    content: "Fix the README typo",
    agentMode: "auto",
    queuedAt: "2026-09-02T10:00:00.000Z"
  }
];

describe("SessionComposer multitask", () => {
  afterEach(cleanup);

  it("dispatches /multitask instead of sending it as a message", async () => {
    const onMultitask = vi.fn().mockResolvedValue(undefined);
    const onSendSessionInput = vi.fn().mockResolvedValue(undefined);
    renderConversation(baseSession({ state: "running" }), [], { onMultitask, onSendSessionInput });

    fireEvent.change(prompt(), { target: { value: "/multitask fix the README typo" } });
    fireEvent.mouseDown(document.body);
    fireEvent.keyDown(prompt(), { key: "Enter" });

    await waitFor(() =>
      expect(onMultitask).toHaveBeenCalledWith("session-a", "fix the README typo")
    );
    // The running turn is left alone: nothing was sent or queued behind it.
    expect(onSendSessionInput).not.toHaveBeenCalled();
    await waitFor(() => expect(prompt().value).toBe(""));
  });

  it("promotes a queued follow-up to a multitask without touching the turn", async () => {
    const onMultitask = vi.fn().mockResolvedValue(undefined);
    const onCancelQueuedMessage = vi.fn().mockResolvedValue(undefined);
    const onSendQueuedMessageNow = vi.fn().mockResolvedValue(undefined);
    renderConversation(baseSession({ state: "running" }), [], {
      pendingMessages: queued,
      onMultitask,
      onCancelQueuedMessage,
      onSendQueuedMessageNow
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Multitask queued follow-up: Fix the README typo" })
    );

    await waitFor(() => expect(onMultitask).toHaveBeenCalledWith("session-a", "Fix the README typo"));
    // It leaves the queue, because it is running now.
    await waitFor(() => expect(onCancelQueuedMessage).toHaveBeenCalledWith("session-a", "pending-1"));
    // And unlike "Send now", it never stops the turn in flight.
    expect(onSendQueuedMessageNow).not.toHaveBeenCalled();
  });

  it("offers no multitask action when the surface cannot dispatch one", () => {
    renderConversation(baseSession({ state: "running" }), [], { pendingMessages: queued });
    expect(
      screen.queryByRole("button", { name: /^Multitask queued follow-up/ })
    ).not.toBeInTheDocument();
  });
});
