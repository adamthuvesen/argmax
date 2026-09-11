// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi } from "../../shared/types.js";
import { usageSummaryFixture } from "../../test/fixtures/usageSummary.js";
import { demoActivitySummary } from "../demoActivity.js";
import {
  getCachedActivitySummary,
  getCachedUsageSummary,
  resetLedgerPageStateForTests
} from "./ledgerPageState.js";
import {
  prefetchLedgerPages,
  resetLedgerPrefetchForTests,
  scheduleLedgerPrefetch
} from "./ledgerPrefetch.js";

describe("ledgerPrefetch", () => {
  const usageSummary = vi.fn<ArgmaxApi["usage"]["summary"]>();
  const activitySummary = vi.fn<ArgmaxApi["activity"]["summary"]>();
  const usageRemaining = vi.fn<ArgmaxApi["usage"]["remaining"]>();
  let api: ArgmaxApi;

  beforeEach(() => {
    resetLedgerPageStateForTests();
    resetLedgerPrefetchForTests();
    usageSummary.mockResolvedValue(usageSummaryFixture());
    activitySummary.mockImplementation((input) =>
      Promise.resolve(demoActivitySummary(input))
    );
    usageRemaining.mockResolvedValue({ fetchedAt: "2026-09-06T12:00:00Z", providers: [] });
    api = {
      usage: { summary: usageSummary, remaining: usageRemaining },
      activity: { summary: activitySummary }
    } as unknown as ArgmaxApi;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fills the cache for the default windows", async () => {
    await prefetchLedgerPages(api);

    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    expect(getCachedUsageSummary("30d", null, timeZone)).not.toBeNull();
    expect(getCachedActivitySummary("30d", null, timeZone)).not.toBeNull();
    expect(usageSummary).toHaveBeenCalledWith(
      expect.objectContaining({ window: "30d", provider: null })
    );
    expect(activitySummary).toHaveBeenCalledWith(
      expect.objectContaining({ window: "30d", projectId: null })
    );
    expect(usageRemaining).toHaveBeenCalled();
  });

  it("skips summaries that are already cached", async () => {
    await prefetchLedgerPages(api);
    usageSummary.mockClear();
    activitySummary.mockClear();
    usageRemaining.mockClear();

    await prefetchLedgerPages(api);

    expect(usageSummary).not.toHaveBeenCalled();
    expect(activitySummary).not.toHaveBeenCalled();
    expect(usageRemaining).not.toHaveBeenCalled();
  });

  it("prefetches remaining in parallel with summaries", async () => {
    let remainingStarted = false;
    usageSummary.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return usageSummaryFixture();
    });
    usageRemaining.mockImplementation(() => {
      remainingStarted = true;
      return Promise.resolve({ fetchedAt: "2026-09-06T12:00:00Z", providers: [] });
    });

    const pending = prefetchLedgerPages(api);
    expect(remainingStarted).toBe(true);
    await pending;
  });

  it("schedules at most once per session", async () => {
    vi.useFakeTimers();
    usageSummary.mockClear();
    scheduleLedgerPrefetch(api);
    scheduleLedgerPrefetch(api);

    await vi.runAllTimersAsync();

    expect(usageSummary).toHaveBeenCalledTimes(1);
  });
});
