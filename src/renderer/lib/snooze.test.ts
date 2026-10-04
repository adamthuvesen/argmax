import { describe, expect, it } from "vitest";
import type { SessionSummary, WorkspaceSummary } from "../../shared/types.js";
import {
  MAX_TIMER_MS,
  activeSnoozeUntil,
  computeSnoozeShelf,
  snoozeChoices,
  snoozeTimerDelay
} from "./snooze.js";

const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

function workspace(id: string, patch: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return { id, pinned: false, state: "running", ...patch } as unknown as WorkspaceSummary;
}

function session(workspaceId: string, attention: string): SessionSummary {
  return { id: `s-${workspaceId}`, workspaceId, attention } as unknown as SessionSummary;
}

describe("snooze shelf", () => {
  it("shelves only rows whose snooze is still in the future", () => {
    const shelf = computeSnoozeShelf(
      [
        workspace("live", { snoozedUntil: iso(60_000) }),
        workspace("expired", { snoozedUntil: iso(-1) }),
        workspace("none"),
        workspace("garbage", { snoozedUntil: "not a date" })
      ],
      [],
      NOW
    );
    expect([...shelf.shelfIds]).toEqual(["live"]);
    expect(shelf.nextExpiryAt).toBe(NOW + 60_000);
  });

  it("keeps a row an agent is waiting on in its section, and a pinned row too", () => {
    const shelf = computeSnoozeShelf(
      [
        workspace("approval", { snoozedUntil: iso(60_000) }),
        workspace("question", { snoozedUntil: iso(60_000) }),
        workspace("pinned", { snoozedUntil: iso(60_000), pinned: true }),
        workspace("quiet", { snoozedUntil: iso(60_000) }),
        workspace("failed", { snoozedUntil: iso(60_000) })
      ],
      [
        session("approval", "approval-needed"),
        session("question", "question-asked"),
        session("failed", "failed")
      ],
      NOW
    );
    // A failed run is not an unanswered request, so it is snoozable.
    expect([...shelf.shelfIds].sort()).toEqual(["failed", "quiet"]);
  });

  it("never shelves an archived row, so it stays in the Archived section", () => {
    const shelf = computeSnoozeShelf(
      [
        workspace("archived", { snoozedUntil: iso(60_000), state: "archived" }),
        workspace("live", { snoozedUntil: iso(60_000) })
      ],
      [],
      NOW
    );
    expect([...shelf.shelfIds]).toEqual(["live"]);
    // An archived row's snooze does not arm the timer either.
    expect(shelf.nextExpiryAt).toBe(NOW + 60_000);
    expect(
      computeSnoozeShelf([workspace("archived", { snoozedUntil: iso(60_000), state: "archived" })], [], NOW)
        .nextExpiryAt
    ).toBeNull();
  });

  it("arms the earliest expiry across every active snooze, urgent or not", () => {
    const shelf = computeSnoozeShelf(
      [
        workspace("later", { snoozedUntil: iso(3_600_000) }),
        workspace("sooner-but-urgent", { snoozedUntil: iso(5_000) })
      ],
      [session("sooner-but-urgent", "approval-needed")],
      NOW
    );
    expect(shelf.nextExpiryAt).toBe(NOW + 5_000);
    expect([...shelf.shelfIds]).toEqual(["later"]);
  });

  it("derives expiry from the clock: the same row leaves the shelf once its time passes", () => {
    const rows = [workspace("w", { snoozedUntil: iso(1_000) })];
    expect(computeSnoozeShelf(rows, [], NOW).shelfIds.has("w")).toBe(true);
    expect(computeSnoozeShelf(rows, [], NOW + 1_000).shelfIds.has("w")).toBe(false);
    expect(activeSnoozeUntil(rows[0], NOW + 1_000)).toBeNull();
  });

  it("clamps the timer delay to what setTimeout can hold", () => {
    expect(snoozeTimerDelay(NOW + 5_000, NOW)).toBe(5_001);
    expect(snoozeTimerDelay(NOW - 5, NOW)).toBe(1);
    expect(snoozeTimerDelay(NOW + 365 * 86_400_000, NOW)).toBe(MAX_TIMER_MS);
  });

  it("offers three future instants, the later two at 9:00 local time", () => {
    const from = new Date(2026, 9, 4, 22, 30, 0);
    const [hour, tomorrow, week] = snoozeChoices(from);
    expect(Date.parse(hour.until)).toBe(from.getTime() + 3_600_000);
    const next = new Date(tomorrow.until);
    expect([next.getDate(), next.getHours(), next.getMinutes()]).toEqual([5, 9, 0]);
    const later = new Date(week.until);
    expect([later.getDate(), later.getHours()]).toEqual([11, 9]);
    for (const choice of [hour, tomorrow, week]) {
      expect(Date.parse(choice.until)).toBeGreaterThan(from.getTime());
    }
  });
});
