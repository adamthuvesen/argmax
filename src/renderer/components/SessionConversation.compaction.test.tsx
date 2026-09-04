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

  // Claude repeats `status:"compacting"` every 30s while the compaction runs.
  it("collapses the repeated compacting heartbeat into one seam", () => {
    renderConversation(baseSession({ state: "complete" }), [
      event("end", "session.compacted", "Compacted context", "2026-05-12T15:02:22.000Z", {
        trigger: "auto",
        preTokens: 466684,
        postTokens: 17974
      }),
      event("beat3", "session.compacting", "Compacting context", "2026-05-12T15:01:03.000Z"),
      event("beat2", "session.compacting", "Compacting context", "2026-05-12T15:00:33.000Z"),
      event("start", "session.compacting", "Compacting context", "2026-05-12T15:00:03.000Z"),
      event("d1", "message.delta", "Working", "2026-05-12T15:00:01.000Z")
    ]);

    expect(screen.getAllByRole("status", { name: /compact/i })).toHaveLength(1);
    expect(screen.getByRole("status", { name: "Compacted context, 467k → 18k tokens" })).toBeTruthy();
  });

  it("keeps a still-running heartbeat live under one marker", () => {
    renderConversation(baseSession({ state: "running" }), [
      event("beat2", "session.compacting", "Compacting context", "2026-05-12T15:00:33.000Z"),
      event("start", "session.compacting", "Compacting context", "2026-05-12T15:00:03.000Z")
    ]);

    const notices = screen.getAllByRole("status", { name: "Compacting" });
    expect(notices).toHaveLength(1);
    expect(notices[0].getAttribute("data-running")).toBe("true");
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
