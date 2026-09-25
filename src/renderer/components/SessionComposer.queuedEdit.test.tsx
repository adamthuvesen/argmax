import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingMessage } from "../../shared/types.js";
import { baseSession, renderConversation } from "../../test/sessionConversationTestHarness.js";
import { resetToastForTests, toastSnapshot } from "../state/toast.js";

function prompt(): HTMLTextAreaElement {
  return screen.getByLabelText("Chat prompt");
}

const queued: PendingMessage[] = [
  {
    id: "pending-1",
    sessionId: "session-a",
    content: "Fix the README typo",
    agentMode: "auto",
    queuedAt: "2026-09-06T10:00:00.000Z"
  }
];

const editButton = (): HTMLElement =>
  screen.getByRole("button", { name: "Edit queued follow-up: Fix the README typo" });

describe("SessionComposer queued follow-up editing", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => { cleanup(); resetToastForTests(); });

  it("takes the queued message out of the queue and back into the prompt", async () => {
    const onCancelQueuedMessage = vi.fn().mockResolvedValue(undefined);
    const onSendQueuedMessageNow = vi.fn().mockResolvedValue(undefined);
    renderConversation(baseSession({ state: "running" }), [], {
      pendingMessages: queued,
      onCancelQueuedMessage,
      onSendQueuedMessageNow
    });

    fireEvent.click(editButton());

    await waitFor(() => expect(prompt().value).toBe("Fix the README typo"));
    // It only lives in one place: the queue no longer holds it.
    expect(onCancelQueuedMessage).toHaveBeenCalledWith("session-a", "pending-1");
    // Reworking it never cuts the turn short the way "Send now" does.
    expect(onSendQueuedMessageNow).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(prompt());
  });

  it("keeps a half-written draft, putting the queued text above it", async () => {
    renderConversation(baseSession({ state: "running" }), [], {
      pendingMessages: queued,
      onCancelQueuedMessage: vi.fn().mockResolvedValue(undefined)
    });

    fireEvent.change(prompt(), { target: { value: "and check the links" } });
    fireEvent.click(editButton());

    await waitFor(() =>
      expect(prompt().value).toBe("Fix the README typo\n\nand check the links")
    );
    // The caret sits at the end of the restored text, which is what is being
    // reworded — not at the end of the draft that followed it.
    expect(prompt().selectionStart).toBe("Fix the README typo".length);
  });

  it("restores queued screenshots alongside an existing draft and sends each reference once", async () => {
    const existing = { filePath: "/attachments/existing.png", mimeType: "image/png" as const, sizeBytes: 4 };
    const queuedImage = { filePath: "/attachments/queued.png", mimeType: "image/png" as const, sizeBytes: 4 };
    window.localStorage.setItem("argmax.composer.drafts", JSON.stringify({
      "session-a": { text: "and check this", attachments: [existing] }
    }));
    const onSendSessionInput = vi.fn().mockResolvedValue(undefined);
    renderConversation(baseSession({ state: "complete" }), [], {
      pendingMessages: [{ ...queued[0], content: "Review the first shot @/attachments/queued.png\n\nOpen files: README.md", attachments: [queuedImage] }],
      onCancelQueuedMessage: vi.fn().mockResolvedValue(undefined),
      onSendSessionInput
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit queued follow-up: Review the first shot @/attachments/queued.png Open files: README.md" }));
    await waitFor(() => expect(prompt()).toHaveValue("Review the first shot\n\nOpen files: README.md\n\nand check this"));
    expect(screen.getAllByRole("button", { name: "View attachment" })).toHaveLength(2);

    fireEvent.keyDown(prompt(), { key: "Enter" });
    await waitFor(() => expect(onSendSessionInput).toHaveBeenCalledTimes(1));
    expect(onSendSessionInput.mock.calls[0][1]).toBe(
      "Review the first shot\n\nOpen files: README.md\n\nand check this @/attachments/existing.png @/attachments/queued.png"
    );
    expect(onSendSessionInput.mock.calls[0][4]).toEqual([existing, queuedImage]);
  });

  it("leaves the prompt alone when the message could not leave the queue", async () => {
    renderConversation(baseSession({ state: "running" }), [], {
      pendingMessages: queued,
      onCancelQueuedMessage: vi.fn().mockRejectedValue(new Error("queue is busy"))
    });

    fireEvent.click(editButton());

    await waitFor(() => expect(toastSnapshot()?.message).toBe("queue is busy"));
    // Restoring it anyway would send the same prompt twice.
    expect(prompt().value).toBe("");
  });

  it("explains recovered and uncertain delivery without sending either", () => {
    const onSendQueuedMessageNow = vi.fn().mockResolvedValue(undefined);
    renderConversation(baseSession({ state: "complete" }), [], {
      pendingMessages: [
        { ...queued[0], recoveryStatus: "unsent" },
        {
          ...queued[0],
          id: "pending-2",
          content: "Check whether this launched",
          recoveryStatus: "delivery-unknown"
        }
      ],
      onCancelQueuedMessage: vi.fn().mockResolvedValue(undefined),
      onSendQueuedMessageNow
    });

    expect(screen.getByText("Paused • not sent")).toBeInTheDocument();
    expect(
      screen.getByText("Delivery uncertain • check the chat before sending again")
    ).toBeInTheDocument();
    expect(onSendQueuedMessageNow).not.toHaveBeenCalled();
  });
});
