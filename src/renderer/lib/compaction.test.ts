import { describe, expect, it } from "vitest";
import type { EventType, TimelineEvent } from "../../shared/types.js";
import { isCompacting } from "./compaction.js";

function event(id: string, type: EventType, createdAt: string): TimelineEvent {
  return { id, sessionId: "s1", type, message: id, payload: {}, createdAt };
}

// Newest-first, the order the dashboard merge keeps.
describe("isCompacting", () => {
  it("reads true while the opening marker is the newest row", () => {
    expect(
      isCompacting([
        event("c1", "session.compacting", "2026-05-12T15:00:01.000Z"),
        event("u1", "user.message", "2026-05-12T15:00:00.000Z")
      ])
    ).toBe(true);
  });

  it("reads false once the closing marker lands", () => {
    expect(
      isCompacting([
        event("c2", "session.compacted", "2026-05-12T15:02:00.000Z"),
        event("c1", "session.compacting", "2026-05-12T15:00:01.000Z")
      ])
    ).toBe(false);
  });

  // A Stop inside the compaction window strands the opening marker: the
  // provider never sends the closing row. Trusting the newest *compaction* row
  // instead of the newest row left the cue suppressed for the rest of the
  // chat's life, so every later turn ran with nothing on screen.
  it("reads false for a marker a Stop stranded, whatever came after it", () => {
    const stranded = event("c1", "session.compacting", "2026-05-12T15:00:01.000Z");
    expect(
      isCompacting([event("x", "session.cancelled", "2026-05-12T15:00:30.000Z"), stranded])
    ).toBe(false);
    expect(
      isCompacting([event("u2", "user.message", "2026-05-12T15:01:00.000Z"), stranded])
    ).toBe(false);
  });

  it("reads false with no compaction rows at all", () => {
    expect(isCompacting([event("u1", "user.message", "2026-05-12T15:00:00.000Z")])).toBe(false);
    expect(isCompacting([])).toBe(false);
  });
});
