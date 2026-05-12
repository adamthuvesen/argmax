import { describe, expect, it } from "vitest";
import { formatElapsed } from "./formatElapsed.js";

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

  it("renders seconds with one decimal under a minute", () => {
    expect(formatElapsed(1_000)).toBe("1.0s");
    expect(formatElapsed(2_100)).toBe("2.1s");
    expect(formatElapsed(59_400)).toBe("59.4s");
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
