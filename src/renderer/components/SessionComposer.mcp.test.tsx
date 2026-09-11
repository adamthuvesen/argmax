import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupAppTestMocks } from "../../test/appTestHarness.js";
import { baseSession, renderConversation } from "../../test/sessionConversationTestHarness.js";

function prompt(): HTMLTextAreaElement {
  return screen.getByLabelText("Chat prompt");
}

describe("SessionComposer /mcp", () => {
  beforeEach(setupAppTestMocks);
  afterEach(cleanup);

  it("opens connections from the slash menu without sending a prompt", async () => {
    const onSendSessionInput = vi.fn().mockResolvedValue(undefined);
    renderConversation(baseSession(), [], { onSendSessionInput });

    fireEvent.change(prompt(), { target: { value: "/mcp" } });
    fireEvent.mouseDown(screen.getByRole("option", { name: /Connections/ }));

    expect(screen.getByRole("dialog", { name: "Connections" })).toBeInTheDocument();
    expect(await screen.findByText("No connections found.")).toBeInTheDocument();
    expect(onSendSessionInput).not.toHaveBeenCalled();
    expect(prompt()).toHaveValue("");
  });

  it("intercepts a typed /mcp instead of sending it to the provider", async () => {
    const onSendSessionInput = vi.fn().mockResolvedValue(undefined);
    renderConversation(baseSession(), [], { onSendSessionInput });

    fireEvent.change(prompt(), { target: { value: "/mcp" } });
    fireEvent.mouseDown(document.body);
    fireEvent.keyDown(prompt(), { key: "Enter" });

    expect(screen.getByRole("dialog", { name: "Connections" })).toBeInTheDocument();
    expect(await screen.findByText("No connections found.")).toBeInTheDocument();
    expect(onSendSessionInput).not.toHaveBeenCalled();
  });
});
