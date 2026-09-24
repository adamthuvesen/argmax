import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  baseSession,
  event,
  renderConversation
} from "../../test/sessionConversationTestHarness.js";

// `events` reach the pane newest-first, matching the dashboard merge order.
describe("SessionConversation session note", () => {
  afterEach(cleanup);

  it("keeps a cloud handoff link accessible in the persisted timeline", () => {
    renderConversation(baseSession({ state: "complete" }), [
      event("cloud", "session.note", "Sent task to Claude Cloud: https://claude.ai/code/session_test123", "2026-05-12T15:02:00.000Z"),
      event("answer", "message.completed", "Ready to hand off", "2026-05-12T15:00:01.000Z")
    ]);
    expect(screen.getByRole("link", { name: "Open task" })).toHaveAttribute("href", "https://claude.ai/code/session_test123");
  });

  it("links every hosted provider's task and leaves a foreign URL as text", () => {
    renderConversation(baseSession({ state: "complete" }), [
      event("foreign", "session.note", "Sent task to Codex Cloud: https://example.com/codex/tasks/task_x", "2026-05-12T15:04:00.000Z"),
      event("cursor", "session.note", "Sent task to Cursor Cloud: https://cursor.com/agents/bc-7f3e2a91", "2026-05-12T15:03:00.000Z"),
      event("codex", "session.note", "Sent task to Codex Cloud: https://chatgpt.com/codex/tasks/task_e_0123", "2026-05-12T15:02:00.000Z"),
      event("answer", "message.completed", "Ready to hand off", "2026-05-12T15:00:01.000Z")
    ]);
    expect(screen.getAllByRole("link", { name: "Open task" }).map((link) => link.getAttribute("href"))).toEqual([
      "https://chatgpt.com/codex/tasks/task_e_0123",
      "https://cursor.com/agents/bc-7f3e2a91"
    ]);
    expect(screen.getByText("Sent task to Codex Cloud: https://example.com/codex/tasks/task_x")).toBeInTheDocument();
  });

  it("shows a note as a quiet line under the turn it lands in", () => {
    renderConversation(baseSession({ state: "complete" }), [
      event(
        "note",
        "session.note",
        "Resuming the archive scheduled before Argmax last quit.",
        "2026-05-12T15:02:00.000Z",
        { operation: "workspace.archive" }
      ),
      event("answer", "message.completed", "Done", "2026-05-12T15:00:01.000Z")
    ]);

    const note = screen.getByText("Resuming the archive scheduled before Argmax last quit.");
    // A live region, so a note that lands while the reader is elsewhere is announced.
    expect(note.closest("[role='status']")).not.toBeNull();
    const answer = screen.getByText("Done");
    // DOCUMENT_POSITION_FOLLOWING === 4: the note sits below the turn.
    expect(answer.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // A notice, not a failure: nothing here is labelled as an error.
    expect(screen.queryByText("Error")).toBeNull();
  });
});
