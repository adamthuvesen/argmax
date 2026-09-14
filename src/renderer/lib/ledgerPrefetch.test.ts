// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi } from "../../shared/types.js";
import { usageSummaryFixture } from "../../test/fixtures/usageSummary.js";
import { ActivityPanel } from "../components/activity/ActivityPanel.js";
import { UsagePanel } from "../components/usage/UsagePanel.js";
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
    usageSummary.mockReset();
    activitySummary.mockReset();
    usageRemaining.mockReset();
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
    cleanup();
    delete window.argmax;
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

  it("lets visible panels join the boot prefetch instead of duplicating reads", async () => {
    let resolveUsage!: (summary: ReturnType<typeof usageSummaryFixture>) => void;
    let resolveActivity!: (summary: ReturnType<typeof demoActivitySummary>) => void;
    let resolveRemaining!: (remaining: Awaited<ReturnType<typeof usageRemaining>>) => void;
    usageSummary.mockImplementation(
      () => new Promise((resolve) => { resolveUsage = resolve; })
    );
    activitySummary.mockImplementation(
      () => new Promise((resolve) => { resolveActivity = resolve; })
    );
    usageRemaining.mockImplementation(
      () => new Promise((resolve) => { resolveRemaining = resolve; })
    );
    window.argmax = api;

    const prefetch = prefetchLedgerPages(api);
    render(createElement(UsagePanel));
    render(createElement(ActivityPanel));

    await waitFor(() => {
      expect(usageSummary).toHaveBeenCalledTimes(1);
      expect(activitySummary).toHaveBeenCalledTimes(1);
      expect(usageRemaining).toHaveBeenCalledTimes(1);
    });

    resolveUsage(usageSummaryFixture());
    resolveActivity(
      demoActivitySummary({ window: "30d", projectId: null, timeZone: "UTC" })
    );
    resolveRemaining({ fetchedAt: "2026-09-06T12:00:00Z", providers: [] });
    await prefetch;
  });

  it("retries after a shared request fails", async () => {
    usageSummary
      .mockRejectedValueOnce(new Error("usage scan failed"))
      .mockResolvedValueOnce(usageSummaryFixture());

    await expect(prefetchLedgerPages(api)).rejects.toThrow("usage scan failed");
    await prefetchLedgerPages(api);

    expect(usageSummary).toHaveBeenCalledTimes(2);
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    expect(getCachedUsageSummary("30d", null, timeZone)).not.toBeNull();
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
