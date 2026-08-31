import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  baseSession,
  event,
  renderConversation
} from "../../test/sessionConversationTestHarness.js";

// `events` reach the pane newest-first, matching the dashboard merge order.
describe("SessionConversation context compaction", () => {
  afterEach(cleanup);

  it("shows a finished compaction seam with the context sizes", () => {
    renderConversation(baseSession({ state: "complete" }), [
      event("d2", "message.delta", "Resumed", "2026-05-12T15:02:01.000Z"),
      event("end", "session.compacted", "Compacted context", "2026-05-12T15:02:00.000Z", {
        trigger: "auto",
        preTokens: 470664,
        postTokens: 10703
      }),
      event("start", "session.compacting", "Compacting context", "2026-05-12T15:00:02.000Z"),
      event("d1", "message.delta", "Working", "2026-05-12T15:00:01.000Z")
    ]);

    // One seam, not one per bracket row.
    expect(screen.getAllByRole("status", { name: /compacted context/i })).toHaveLength(1);
    expect(screen.getByRole("status", { name: "Compacted context, 471k → 10.7k tokens" })).toBeTruthy();
  });

  it("marks an unfinished compaction live and holds back the Thinking label", () => {
    renderConversation(baseSession({ state: "running" }), [
      event("start", "session.compacting", "Compacting context", "2026-05-12T15:00:02.000Z"),
      event("d1", "message.delta", "Working", "2026-05-12T15:00:01.000Z")
    ]);

    const notice = screen.getByRole("status", { name: "Compacting" });
    expect(notice.getAttribute("data-running")).toBe("true");
    expect(screen.queryByTestId("thinking-label")).toBeNull();
  });
});
