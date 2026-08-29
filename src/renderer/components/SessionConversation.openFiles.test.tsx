import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseSession, renderConversation, reviewStub } from "../../test/sessionConversationTestHarness.js";
import type { ArgmaxApi } from "../../shared/types.js";

function reviewWithOpenTabs(overrides: Partial<Parameters<typeof reviewStub>[0]> = {}) {
  const stub = reviewStub({ isPanelOpen: true, mode: "files", ...overrides });
  return {
    ...stub,
    workspaceFiles: {
      ...stub.workspaceFiles,
      tabs: [
        { path: "docs/notes.md", isDirty: false, saveState: "idle" as const, externalChange: false },
        { path: "models/query.sql", isDirty: false, saveState: "idle" as const, externalChange: false }
      ],
      activeTabPath: "models/query.sql"
    }
  };
}

describe("SessionConversation open-file context", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.argmax = {
      prs: { listForSession: vi.fn(() => new Promise(() => {})) }
    } as unknown as ArgmaxApi;
  });

  afterEach(() => {
    cleanup();
  });

  it("shows the open-files chip while the review panel has tabs open", () => {
    renderConversation(baseSession(), [], { review: reviewWithOpenTabs() });
    expect(screen.getByLabelText("Attached context: Open files: query.sql +1")).toBeTruthy();
  });

  it("hides the chip when the review panel is closed", () => {
    renderConversation(baseSession(), [], { review: reviewWithOpenTabs({ isPanelOpen: false }) });
    expect(screen.queryByLabelText(/^Attached context:/)).toBeNull();
  });

  it("appends the open files as @path references, active tab first", async () => {
    const onSendSessionInput = vi.fn().mockResolvedValue(undefined);
    renderConversation(baseSession(), [], { onSendSessionInput, review: reviewWithOpenTabs() });

    const prompt = screen.getByLabelText("Session prompt");
    fireEvent.change(prompt, { target: { value: "explain this model" } });
    fireEvent.keyDown(prompt, { key: "Enter" });

    await waitFor(() => expect(onSendSessionInput).toHaveBeenCalled());
    expect(onSendSessionInput.mock.calls[0]?.[1]).toBe(
      "explain this model\n\nFor context, I have these files open in the editor:\n@models/query.sql\n@docs/notes.md"
    );
  });

  it("sends the plain prompt after the chip is dismissed", async () => {
    const onSendSessionInput = vi.fn().mockResolvedValue(undefined);
    renderConversation(baseSession(), [], { onSendSessionInput, review: reviewWithOpenTabs() });

    fireEvent.click(screen.getByRole("button", { name: "Don't attach open files" }));
    expect(screen.queryByLabelText(/^Attached context:/)).toBeNull();

    const prompt = screen.getByLabelText("Session prompt");
    fireEvent.change(prompt, { target: { value: "explain this model" } });
    fireEvent.keyDown(prompt, { key: "Enter" });

    await waitFor(() => expect(onSendSessionInput).toHaveBeenCalled());
    expect(onSendSessionInput.mock.calls[0]?.[1]).toBe("explain this model");
  });
});
