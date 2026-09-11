import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { baseSession, renderConversation } from "../../test/sessionConversationTestHarness.js";
import type { TimelineEvent } from "../../shared/types.js";

// One edited file, as the phone's turn-changes card sees it.
const editEvents: TimelineEvent[] = [
  {
    id: "edit-start",
    sessionId: "session-1",
    type: "command.started",
    message: "Edit",
    payload: {
      id: "edit-1",
      name: "Edit",
      input: { file_path: "/tmp/worktrees/dashboard/CHANGELOG.md", old_string: "2025", new_string: "2026" }
    },
    createdAt: "2026-05-08T15:54:02.000Z"
  },
  {
    id: "edit-done",
    sessionId: "session-1",
    type: "command.completed",
    message: "Edit",
    payload: { id: "edit-1", name: "Edit", output: "ok" },
    createdAt: "2026-05-08T15:54:03.000Z"
  },
  {
    id: "answer",
    sessionId: "session-1",
    type: "message.completed",
    message: "Fixed the date.",
    payload: {},
    createdAt: "2026-05-08T15:54:04.000Z"
  }
] as TimelineEvent[];

/** The turn's activity rows name the same file, so reach the row through the
 *  changes card's own header rather than by label alone. */
function changesCard(): HTMLElement {
  const collapsed = screen.queryByRole("button", { name: "Show 1 file changed" });
  if (collapsed) fireEvent.click(collapsed);
  const header = screen.getByRole("button", { name: "Hide 1 file changed" });
  const card = header.closest("section");
  if (!card) throw new Error("turn changes card is not a section");
  return card;
}

describe("SessionConversation — a host with its own review surface", () => {
  afterEach(cleanup);

  it("routes a tapped changed file to the host instead of the dock", () => {
    const onOpenDiff = vi.fn();
    renderConversation(baseSession(), editEvents, { onOpenDiff });
    fireEvent.click(within(changesCard()).getByRole("button", { name: "Edited CHANGELOG.md" }));

    expect(onOpenDiff).toHaveBeenCalledWith("CHANGELOG.md");
  });

  it("routes the card's Review button to the host too", () => {
    const onOpenChanges = vi.fn();
    renderConversation(baseSession(), editEvents, { onOpenChanges });
    fireEvent.click(within(changesCard()).getByRole("button", { name: /^Review/ }));

    expect(onOpenChanges).toHaveBeenCalledTimes(1);
  });
});
