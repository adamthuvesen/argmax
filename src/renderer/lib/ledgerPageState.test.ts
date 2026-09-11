import { beforeEach, describe, expect, it, vi } from "vitest";
import { usageSummaryFixture } from "../../test/fixtures/usageSummary.js";
import { demoActivitySummary } from "../demoActivity.js";
import {
  getCachedActivitySummary,
  getCachedUsageSummary,
  requestUsageSummary,
  resetLedgerPageStateForTests,
  setCachedActivitySummary,
  setCachedUsageSummary
} from "./ledgerPageState.js";

describe("ledgerPageState", () => {
  beforeEach(() => {
    resetLedgerPageStateForTests();
  });

  it("bounds activity filter results while keeping the default warm summary", () => {
    const timeZone = "Europe/Stockholm";
    const summary = demoActivitySummary({ window: "30d", projectId: null, timeZone });
    setCachedActivitySummary("30d", null, timeZone, summary);

    for (let index = 1; index <= 8; index += 1) {
      setCachedActivitySummary("30d", `project-${index}`, timeZone, summary);
    }

    expect(getCachedActivitySummary("30d", null, timeZone)).toBe(summary);
    expect(getCachedActivitySummary("30d", "project-1", timeZone)).toBeNull();
    expect(getCachedActivitySummary("30d", "project-8", timeZone)).toBe(summary);
  });

  it("uses recent access when evicting usage filter results", () => {
    const timeZone = "UTC";
    const summary = usageSummaryFixture();
    setCachedUsageSummary("30d", null, timeZone, summary);
    setCachedUsageSummary("24h", "claude", timeZone, summary);
    setCachedUsageSummary("24h", "codex", timeZone, summary);
    setCachedUsageSummary("24h", "cursor", timeZone, summary);
    setCachedUsageSummary("24h", "opencode", timeZone, summary);
    setCachedUsageSummary("24h", "grok", timeZone, summary);
    setCachedUsageSummary("7d", "claude", timeZone, summary);
    setCachedUsageSummary("7d", "codex", timeZone, summary);

    expect(getCachedUsageSummary("24h", "claude", timeZone)).toBe(summary);
    setCachedUsageSummary("7d", "cursor", timeZone, summary);

    expect(getCachedUsageSummary("30d", null, timeZone)).toBe(summary);
    expect(getCachedUsageSummary("24h", "claude", timeZone)).toBe(summary);
    expect(getCachedUsageSummary("24h", "codex", timeZone)).toBeNull();
  });

  it("clears a rejected shared request so the same view can retry", async () => {
    const summary = usageSummaryFixture();
    let reject!: (cause: Error) => void;
    const fetch = vi
      .fn<() => Promise<typeof summary>>()
      .mockImplementationOnce(() => new Promise((_, rejectRequest) => { reject = rejectRequest; }))
      .mockResolvedValueOnce(summary);

    const first = requestUsageSummary("30d", null, "UTC", fetch);
    const joined = requestUsageSummary("30d", null, "UTC", fetch);
    expect(joined).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(1);

    reject(new Error("usage scan failed"));
    const failed = await Promise.allSettled([first, joined]);
    expect(failed.every((result) => result.status === "rejected")).toBe(true);

    await requestUsageSummary("30d", null, "UTC", fetch);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(getCachedUsageSummary("30d", null, "UTC")).toBe(summary);
  });
});
