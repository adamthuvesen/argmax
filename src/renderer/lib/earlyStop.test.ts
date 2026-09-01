import { describe, expect, it } from "vitest";
import { EARLY_STOP_WINDOW_MS, isEarlySessionStop } from "./earlyStop.js";

describe("isEarlySessionStop", () => {
  const baseTime = 1_700_000_000_000;

  it("returns true when stopped immediately (0ms elapsed)", () => {
    const startedAt = new Date(baseTime).toISOString();
    expect(isEarlySessionStop({ startedAt }, baseTime)).toBe(true);
  });

  it("returns true when stopped within 10s (5s elapsed)", () => {
    const startedAt = new Date(baseTime).toISOString();
    expect(isEarlySessionStop({ startedAt }, baseTime + 5_000)).toBe(true);
  });

  it("returns true at exactly 10s boundary", () => {
    const startedAt = new Date(baseTime).toISOString();
    expect(isEarlySessionStop({ startedAt }, baseTime + EARLY_STOP_WINDOW_MS)).toBe(true);
  });

  it("returns false when stopped after 10s (10.001s elapsed)", () => {
    const startedAt = new Date(baseTime).toISOString();
    expect(isEarlySessionStop({ startedAt }, baseTime + 10_001)).toBe(false);
  });

  it("returns false when stopped after 1 minute", () => {
    const startedAt = new Date(baseTime).toISOString();
    expect(isEarlySessionStop({ startedAt }, baseTime + 60_000)).toBe(false);
  });

  it("returns false for null or undefined session", () => {
    expect(isEarlySessionStop(null, baseTime)).toBe(false);
    expect(isEarlySessionStop(undefined, baseTime)).toBe(false);
  });

  it("returns false for missing or invalid startedAt", () => {
    expect(isEarlySessionStop({ startedAt: "" }, baseTime)).toBe(false);
    expect(isEarlySessionStop({ startedAt: "not-a-date" }, baseTime)).toBe(false);
  });

  it("returns true for small negative skew within 60s", () => {
    const startedAt = new Date(baseTime + 1_000).toISOString();
    expect(isEarlySessionStop({ startedAt }, baseTime)).toBe(true);
  });

  it("returns false for absurd future timestamp (> 60s in future)", () => {
    const startedAt = new Date(baseTime + 120_000).toISOString();
    expect(isEarlySessionStop({ startedAt }, baseTime)).toBe(false);
  });
});
