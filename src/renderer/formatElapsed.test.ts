import { describe, expect, it } from "vitest";
import { formatElapsed, formatElapsedSeconds } from "./formatElapsed.js";

describe("formatElapsed", () => {
  it("returns an em-dash sentinel for invalid input", () => {
    expect(formatElapsed(Number.NaN)).toBe("—");
    expect(formatElapsed(-100)).toBe("—");
    expect(formatElapsed(Number.POSITIVE_INFINITY)).toBe("—");
  });

  it("renders sub-second durations to one decimal", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(120)).toBe("0.1s");
    expect(formatElapsed(440)).toBe("0.4s");
    expect(formatElapsed(900)).toBe("0.9s");
  });

  it("renders seconds with one decimal under 10 seconds", () => {
    expect(formatElapsed(1_000)).toBe("1.0s");
    expect(formatElapsed(2_100)).toBe("2.1s");
    expect(formatElapsed(9_900)).toBe("9.9s");
  });

  it("rounds to whole seconds between 10 and 60 seconds", () => {
    // Past 10s, sub-second precision is noise — a dropped frame reads as a
    // visible jump. Whole seconds change once per real second, so the counter
    // ticks at a regular cadence even under main-thread contention.
    expect(formatElapsed(10_000)).toBe("10s");
    expect(formatElapsed(16_500)).toBe("17s");
    expect(formatElapsed(59_400)).toBe("59s");
  });

  it("switches to minutes and seconds past 60s", () => {
    expect(formatElapsed(60_000)).toBe("1m 0s");
    expect(formatElapsed(72_000)).toBe("1m 12s");
    expect(formatElapsed(605_000)).toBe("10m 5s");
  });

  it("switches to hours and minutes past an hour", () => {
    expect(formatElapsed(3_600_000)).toBe("1h 0m");
    expect(formatElapsed(3_900_000)).toBe("1h 5m");
  });
});

describe("formatElapsedSeconds", () => {
  it("returns an em-dash sentinel for invalid input", () => {
    expect(formatElapsedSeconds(Number.NaN)).toBe("—");
    expect(formatElapsedSeconds(-100)).toBe("—");
    expect(formatElapsedSeconds(Number.POSITIVE_INFINITY)).toBe("—");
  });

  it("floors to whole seconds so the ticker advances exactly once per second", () => {
    // Stopwatch semantics — 999ms is still "0s elapsed", 1000ms becomes "1s".
    // This avoids the fractional jitter (3.2s → 5.4s) the user complained about.
    expect(formatElapsedSeconds(0)).toBe("0s");
    expect(formatElapsedSeconds(500)).toBe("0s");
    expect(formatElapsedSeconds(999)).toBe("0s");
    expect(formatElapsedSeconds(1_000)).toBe("1s");
    expect(formatElapsedSeconds(2_900)).toBe("2s");
    expect(formatElapsedSeconds(59_999)).toBe("59s");
  });

  it("switches to minutes and seconds past 60s", () => {
    expect(formatElapsedSeconds(60_000)).toBe("1m 0s");
    expect(formatElapsedSeconds(72_000)).toBe("1m 12s");
    expect(formatElapsedSeconds(605_000)).toBe("10m 5s");
  });

  it("switches to hours and minutes past an hour", () => {
    expect(formatElapsedSeconds(3_600_000)).toBe("1h 0m");
    expect(formatElapsedSeconds(3_900_000)).toBe("1h 5m");
  });
});
