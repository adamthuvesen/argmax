import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { baseSession, renderConversation } from "../../test/sessionConversationTestHarness.js";

function prompt(): HTMLTextAreaElement {
  return screen.getByLabelText("Session prompt");
}

describe("SessionComposer /clear", () => {
  afterEach(cleanup);

  it("runs Clear from the slash menu without sending a prompt", () => {
    const onClearSession = vi.fn().mockResolvedValue(undefined);
    const onSendSessionInput = vi.fn().mockResolvedValue(undefined);
    renderConversation(baseSession({ state: "complete" }), [], { onClearSession, onSendSessionInput });

    fireEvent.change(prompt(), { target: { value: "/clear" } });
    fireEvent.mouseDown(screen.getByRole("option", { name: /Clear/ }));

    expect(onClearSession).toHaveBeenCalledWith("session-a");
    expect(onSendSessionInput).not.toHaveBeenCalled();
    expect(prompt().value).toBe("");
  });

  it("treats a sent /clear as the command, not a user message", async () => {
    const onClearSession = vi.fn().mockResolvedValue(undefined);
    const onSendSessionInput = vi.fn().mockResolvedValue(undefined);
    renderConversation(baseSession({ state: "complete" }), [], { onClearSession, onSendSessionInput });

    fireEvent.change(prompt(), { target: { value: "/clear" } });
    fireEvent.mouseDown(document.body);
    fireEvent.keyDown(prompt(), { key: "Enter" });

    await waitFor(() => expect(onClearSession).toHaveBeenCalledWith("session-a"));
    expect(onSendSessionInput).not.toHaveBeenCalled();
  });
});
