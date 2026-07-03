import { describe, expect, it } from "vitest";
import {
  FAB_VISIBLE_PX,
  NEAR_BOTTOM_PX,
  decideSmartFollow
} from "./smartFollow.js";

describe("decideSmartFollow", () => {
  it("pins when the user is exactly at the bottom", () => {
    const d = decideSmartFollow(1000, 800, 200);
    expect(d.distanceFromBottom).toBe(0);
    expect(d.pinToBottom).toBe(true);
    expect(d.showFab).toBe(false);
  });

  it("pins inside the near-bottom band", () => {
    // 50 px from bottom — inside the 80px pin band, outside the 120px FAB band.
    const d = decideSmartFollow(1000, 750, 200);
    expect(d.distanceFromBottom).toBe(50);
    expect(d.pinToBottom).toBe(true);
    expect(d.showFab).toBe(false);
  });

  it("does not pin once the gap crosses the NEAR_BOTTOM_PX threshold", () => {
    // 80 px exactly — the boundary uses strict <, so NOT pinned.
    const d = decideSmartFollow(1000, 720, 200);
    expect(d.distanceFromBottom).toBe(NEAR_BOTTOM_PX);
    expect(d.pinToBottom).toBe(false);
    expect(d.showFab).toBe(false);
  });

  it("hysteresis band between 80 and 120 px hides the FAB without pinning", () => {
    // 100 px — not pinned, FAB not yet visible.
    const d = decideSmartFollow(1000, 700, 200);
    expect(d.distanceFromBottom).toBe(100);
    expect(d.pinToBottom).toBe(false);
    expect(d.showFab).toBe(false);
  });

  it("shows the FAB once the user is far enough up", () => {
    // 200 px above the bottom — well past 120 px threshold.
    const d = decideSmartFollow(1000, 600, 200);
    expect(d.distanceFromBottom).toBe(200);
    expect(d.pinToBottom).toBe(false);
    expect(d.showFab).toBe(true);
  });

  it("FAB threshold uses strict > — exactly 120 px does NOT show FAB yet", () => {
    const d = decideSmartFollow(1000, 680, 200);
    expect(d.distanceFromBottom).toBe(FAB_VISIBLE_PX);
    expect(d.showFab).toBe(false);
  });

  it("clamps over-scroll (negative distance) to zero so smooth-scroll overshoot still pins", () => {
    // Some browsers report a negative gap mid-smooth-scroll. Treat as 0.
    const d = decideSmartFollow(1000, 850, 200);
    expect(d.distanceFromBottom).toBe(0);
    expect(d.pinToBottom).toBe(true);
    expect(d.showFab).toBe(false);
  });

  it("treats the follow offset as live bottom space", () => {
    const d = decideSmartFollow(1160, 800, 200, 160);
    expect(d.distanceFromBottom).toBe(0);
    expect(d.pinToBottom).toBe(true);
    expect(d.showFab).toBe(false);
  });

  it("handles a short list (clientHeight >= scrollHeight) as pinned", () => {
    // List fits in the viewport — nothing to scroll.
    const d = decideSmartFollow(150, 0, 200);
    expect(d.distanceFromBottom).toBe(0);
    expect(d.pinToBottom).toBe(true);
    expect(d.showFab).toBe(false);
  });

  it("handles non-finite measurements gracefully", () => {
    // If the DOM hasn't laid out yet, callers can pass NaN. Treat as pinned.
    const d = decideSmartFollow(Number.NaN, 0, 200);
    expect(d.distanceFromBottom).toBe(0);
    expect(d.pinToBottom).toBe(true);
    expect(d.showFab).toBe(false);
  });
});
