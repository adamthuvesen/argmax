import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { baseSession, renderConversation } from "../../test/sessionConversationTestHarness.js";

function runningComposer() {
  const order: string[] = [];
  const onTerminateSession = vi.fn(() => {
    order.push("terminate");
    return Promise.resolve();
  });
  const onSendSessionInput = vi.fn(() => {
    order.push("send");
    return Promise.resolve();
  });
  renderConversation(baseSession({ state: "running" }), [], {
    onSendSessionInput,
    onTerminateSession
  });
  return { order, onSendSessionInput, onTerminateSession };
}

describe("SessionComposer — send now", () => {
  afterEach(() => {
    cleanup();
  });

  it("cancels the live turn before sending the draft when Send now is clicked", async () => {
    const { order, onSendSessionInput, onTerminateSession } = runningComposer();

    const prompt = screen.getByLabelText("Session prompt");
    fireEvent.change(prompt, { target: { value: "MCP" } });
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));

    await waitFor(() => expect(onSendSessionInput).toHaveBeenCalled());
    // The interrupt has to land first, otherwise the follow-up queues behind
    // whatever the provider is still emitting.
    expect(order).toEqual(["terminate", "send"]);
    expect(onTerminateSession).toHaveBeenCalledWith("session-a");
    expect(onSendSessionInput).toHaveBeenCalledWith(
      "session-a",
      "MCP",
      expect.objectContaining({ provider: "codex" }),
      "auto",
      undefined
    );
    await waitFor(() => expect((prompt as HTMLTextAreaElement).value).toBe(""));
  });

  it("queues on Enter instead of interrupting the running turn", async () => {
    const { onSendSessionInput, onTerminateSession } = runningComposer();

    const prompt = screen.getByLabelText("Session prompt");
    fireEvent.change(prompt, { target: { value: "MCP" } });
    fireEvent.keyDown(prompt, { key: "Enter" });

    await waitFor(() => expect(onSendSessionInput).toHaveBeenCalled());
    expect(onTerminateSession).not.toHaveBeenCalled();
  });

  it("stops without sending the draft when Stop is clicked", async () => {
    const { onSendSessionInput, onTerminateSession } = runningComposer();

    const prompt = screen.getByLabelText("Session prompt");
    fireEvent.change(prompt, { target: { value: "MCP" } });
    fireEvent.click(screen.getByRole("button", { name: "Stop session" }));

    await waitFor(() => expect(onTerminateSession).toHaveBeenCalledWith("session-a"));
    expect(onSendSessionInput).not.toHaveBeenCalled();
    expect((prompt as HTMLTextAreaElement).value).toBe("MCP");
  });

  it("disables Send now on an empty draft while Stop stays available", () => {
    runningComposer();

    expect(screen.getByRole("button", { name: "Send now" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stop session" })).toBeEnabled();
  });
});
