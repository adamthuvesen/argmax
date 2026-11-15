import { afterEach, beforeEach, vi } from "vitest";

export const FIXED_NOW_MS = Date.UTC(2026, 10, 11, 12, 0, 0);
export const FIXED_NOW_ISO = new Date(FIXED_NOW_MS).toISOString();

export function isoAgo(ms: number): string {
  return new Date(FIXED_NOW_MS - ms).toISOString();
}

export function isoFromNow(ms: number): string {
  return new Date(FIXED_NOW_MS + ms).toISOString();
}

/** Freezes `Date` at FIXED_NOW_MS for each test; timers stay real unless the test fakes them. */
export function freezeClock(): void {
  beforeEach(() => {
    vi.setSystemTime(FIXED_NOW_MS);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}
