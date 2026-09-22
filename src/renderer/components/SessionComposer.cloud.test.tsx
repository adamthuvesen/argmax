import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupAppTestMocks } from "../../test/appTestHarness.js";
import { baseSession, renderConversation, reviewStub } from "../../test/sessionConversationTestHarness.js";

function prompt(): HTMLTextAreaElement {
  return screen.getByLabelText("Chat prompt");
}

describe("SessionComposer /cloud", () => {
  beforeEach(() => {
    setupAppTestMocks();
    vi.spyOn(window.argmax!.cloud, "prepare").mockResolvedValue({
      provider: "codex",
      repository: "adamthuvesen/commute-cli",
      branch: "main",
      commit: "1234567890abcdef",
      brief: "Earlier chat context",
      environmentId: "env-default",
      environmentDescription: "Default",
      environments: [{ id: "env-default", name: "Default" }]
    });
    vi.spyOn(window.argmax!.cloud, "launch").mockResolvedValue({
      url: "https://chatgpt.com/codex/tasks/task-1"
    });
  });

  afterEach(cleanup);

  it("routes the current prompt to the selected hosted provider and preserves it on cancel", async () => {
    const onSendSessionInput = vi.fn().mockResolvedValue(undefined);
    renderConversation(baseSession(), [], { onSendSessionInput });

    fireEvent.change(prompt(), { target: { value: "/cloud Fix the parser" } });
    fireEvent.mouseDown(document.body);
    fireEvent.keyDown(prompt(), { key: "Enter" });

    const dialog = await screen.findByRole("dialog", { name: "Send task to Codex Cloud" });
    expect(within(dialog).getByText("Fix the parser")).toBeInTheDocument();
    expect(prompt()).toHaveValue("/cloud Fix the parser");
    expect(window.argmax!.cloud.prepare).toHaveBeenCalledWith({
      sessionId: "session-a",
      provider: "codex"
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(prompt()).toHaveValue("/cloud Fix the parser");
    expect(onSendSessionInput).not.toHaveBeenCalled();

    fireEvent.keyDown(prompt(), { key: "Enter" });
    await screen.findByRole("dialog", { name: "Send task to Codex Cloud" });
    fireEvent.click(screen.getByRole("button", { name: "Send task" }));

    await screen.findByRole("link", { name: "Open in Codex Cloud" });
    expect(window.argmax!.cloud.launch).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-a",
      provider: "codex",
      brief: "Fix the parser\n\nContext from this chat:\nEarlier chat context"
    }));
    await waitFor(() => expect(prompt()).toHaveValue(""));
    expect(onSendSessionInput).not.toHaveBeenCalled();
  });

  it("does not silently omit open-file context from a cloud task", async () => {
    const review = reviewStub({ isPanelOpen: true, mode: "files" });
    review.workspaceFiles.tabs = [
      { path: "src/parser.ts", isDirty: false, saveState: "idle", externalChange: false }
    ];
    review.workspaceFiles.activeTabPath = "src/parser.ts";
    renderConversation(baseSession(), [], { review });

    fireEvent.change(prompt(), { target: { value: "/cloud Fix the parser" } });
    fireEvent.mouseDown(document.body);
    fireEvent.keyDown(prompt(), { key: "Enter" });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Cloud tasks can’t include local annotations or open files"
    );
    expect(prompt()).toHaveValue("/cloud Fix the parser");
    expect(window.argmax!.cloud.prepare).not.toHaveBeenCalled();
  });
});
