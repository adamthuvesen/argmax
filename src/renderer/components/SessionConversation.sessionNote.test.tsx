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
