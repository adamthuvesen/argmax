import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseSession, renderConversation } from "../../test/sessionConversationTestHarness.js";

function runningComposer() {
  const onTerminateSession = vi.fn(() => Promise.resolve());
  const onSendSessionInput = vi.fn(() => Promise.resolve());
  renderConversation(baseSession({ state: "running" }), [], {
    onSendSessionInput,
    onTerminateSession
  });
  return { onSendSessionInput, onTerminateSession };
}

describe("SessionComposer — running turn controls", () => {
  afterEach(() => {
    cleanup();
  });

  it("queues on Enter instead of interrupting the running turn", async () => {
    const { onSendSessionInput, onTerminateSession } = runningComposer();

    const prompt = screen.getByLabelText("Chat prompt");
    fireEvent.change(prompt, { target: { value: "MCP" } });
    fireEvent.keyDown(prompt, { key: "Enter" });

    await waitFor(() => expect(onSendSessionInput).toHaveBeenCalled());
    expect(onTerminateSession).not.toHaveBeenCalled();
  });

  it("steers on Enter when configured as the default", async () => {
    const onSendSessionInput = vi.fn(() => Promise.resolve());
    renderConversation(baseSession({ state: "running" }), [], {
      defaultFollowUpDelivery: "steer",
      onSendSessionInput
    });

    const prompt = screen.getByLabelText("Chat prompt");
    fireEvent.change(prompt, { target: { value: "Prioritize the migration" } });
    fireEvent.keyDown(prompt, { key: "Enter" });

    await waitFor(() =>
      expect(onSendSessionInput).toHaveBeenCalledWith(
        "session-a",
        "Prioritize the migration",
        expect.anything(),
        "auto",
        undefined,
        undefined,
        "steer"
      )
    );
  });

  it("queues instead of steering when Codex is close to compaction", async () => {
    const onSendSessionInput = vi.fn(() => Promise.resolve());
    renderConversation(
      baseSession({
        state: "running",
        contextTokens: 226_235,
        contextWindow: 258_400
      }),
      [],
      {
        defaultFollowUpDelivery: "steer",
        onSendSessionInput
      }
    );

    const prompt = screen.getByLabelText("Chat prompt");
    fireEvent.change(prompt, { target: { value: "Prioritize the migration" } });
    fireEvent.keyDown(prompt, { key: "Enter" });

    await waitFor(() =>
      expect(onSendSessionInput).toHaveBeenCalledWith(
        "session-a",
        "Prioritize the migration",
        expect.anything(),
        "auto",
        undefined
      )
    );
  });

  it("stops without sending the draft when Stop is clicked", async () => {
    const { onSendSessionInput, onTerminateSession } = runningComposer();

    const prompt = screen.getByLabelText("Chat prompt");
    fireEvent.change(prompt, { target: { value: "MCP" } });
    fireEvent.click(screen.getByRole("button", { name: "Stop chat" }));

    await waitFor(() => expect(onTerminateSession).toHaveBeenCalledWith("session-a"));
    expect(onSendSessionInput).not.toHaveBeenCalled();
    expect((prompt as HTMLTextAreaElement).value).toBe("MCP");
  });

  it("shows Stop as the only send-slot control while running", () => {
    runningComposer();

    // Interrupt-and-send lives on the queued chip's "Send now", not here — a
    // second send button beside Stop read as a puzzle.
    expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Queue follow-up" })).toBeNull();
    expect(screen.getByRole("button", { name: "Stop chat" })).toBeEnabled();
  });

  describe("on a touch surface", () => {
    beforeEach(() => {
      vi.spyOn(window, "matchMedia").mockImplementation(
        (query: string) => ({ matches: query.includes("coarse"), media: query }) as MediaQueryList
      );
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("queues the draft from a button, since a thumb has no Enter key", async () => {
      const { onSendSessionInput, onTerminateSession } = runningComposer();

      // Nothing to queue yet: the running turn keeps its single control.
      expect(screen.queryByRole("button", { name: "Queue follow-up" })).toBeNull();

      fireEvent.change(screen.getByLabelText("Chat prompt"), { target: { value: "MCP" } });
      fireEvent.click(screen.getByRole("button", { name: "Queue follow-up" }));

      await waitFor(() =>
        expect(onSendSessionInput).toHaveBeenCalledWith(
          "session-a",
          "MCP",
          expect.anything(),
          "auto",
          undefined
        )
      );
      expect(onTerminateSession).not.toHaveBeenCalled();
    });
  });
});
