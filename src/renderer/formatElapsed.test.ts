import { describe, expect, it } from "vitest";
import { formatElapsedSeconds, formatThoughtLabel } from "./formatElapsed.js";

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

describe("formatThoughtLabel", () => {
  it("uses Thinking while live and Thought once done", () => {
    expect(formatThoughtLabel(true, 12_000)).toBe("Thinking");
    expect(formatThoughtLabel(false)).toBe("Thought");
    expect(formatThoughtLabel(false, 400)).toBe("Thought");
    expect(formatThoughtLabel(false, 5_000)).toBe("Thought 5s");
  });
});
