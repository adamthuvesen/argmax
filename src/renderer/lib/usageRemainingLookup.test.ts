// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi, UsageRemaining } from "../../shared/types.js";
import {
  getCachedUsageRemaining,
  getCachedUsageRemainingError,
  recordUsageRemainingFailure,
  resetLedgerPageStateForTests,
  setCachedUsageRemaining
} from "./ledgerPageState.js";
import {
  lookUpUsageRemaining,
  remainingFiguresAreOld,
  summarizeProviderRemaining,
  summarizeProviderWithHeld
} from "./usageRemainingLookup.js";

const NOW = Date.parse("2026-10-04T08:00:00Z");

function remaining(fetchedAt: string, percent = 62): UsageRemaining {
  return {
    fetchedAt,
    providers: [
      {
        provider: "claude",
        kind: "subscription",
        planLabel: "Max",
        message: null,
        messageUrl: null,
        windows: [
          { id: "5h", label: "5-hour", remainingPercent: percent, resetsAt: "2026-10-04T10:00:00Z" },
          { id: "week", label: "Weekly", remainingPercent: 90, resetsAt: null }
        ]
      },
      { provider: "codex", kind: "api_key", planLabel: null, message: null, messageUrl: null, windows: [] }
    ]
  };
}

describe("lookUpUsageRemaining", () => {
  const fetchRemaining = vi.fn<ArgmaxApi["usage"]["remaining"]>();

  beforeEach(() => {
    resetLedgerPageStateForTests();
    fetchRemaining.mockReset();
    window.argmax = { usage: { remaining: fetchRemaining } } as unknown as ArgmaxApi;
  });
  afterEach(() => {
    delete (window as unknown as { argmax?: unknown }).argmax;
  });

  it("shares one read between composers that ask at once, and caches it", async () => {
    fetchRemaining.mockResolvedValue(remaining("2026-10-04T07:59:00Z"));

    const [first, second] = await Promise.all([
      lookUpUsageRemaining({ now: NOW }),
      lookUpUsageRemaining({ now: NOW })
    ]);

    expect(fetchRemaining).toHaveBeenCalledOnce();
    expect(first).toBe(second);
    expect(getCachedUsageRemaining()).toBe(first);

    // A later lookup inside the freshness window reads the cache.
    await lookUpUsageRemaining({ now: NOW + 60_000 });
    expect(fetchRemaining).toHaveBeenCalledOnce();
  });

  it("refreshes a stale read, and lets a manual press refresh sooner but not back to back", async () => {
    fetchRemaining.mockResolvedValue(remaining("2026-10-04T07:50:00Z"));
    await lookUpUsageRemaining({ now: NOW });
    expect(fetchRemaining).toHaveBeenCalledOnce();

    // Nine minutes after a read: stale, so any lookup refreshes.
    fetchRemaining.mockResolvedValue(remaining("2026-10-04T08:09:00Z"));
    await lookUpUsageRemaining({ now: NOW + 9 * 60_000 });
    expect(fetchRemaining).toHaveBeenCalledTimes(2);

    // Two minutes on: not stale, but a manual press is allowed past the cooldown.
    fetchRemaining.mockResolvedValue(remaining("2026-10-04T08:11:00Z"));
    await lookUpUsageRemaining({ manual: true, now: NOW + 11 * 60_000 });
    expect(fetchRemaining).toHaveBeenCalledTimes(3);

    // Ten seconds after that read, a second press is served from the cache.
    await lookUpUsageRemaining({ manual: true, now: NOW + 11 * 60_000 + 10_000 });
    expect(fetchRemaining).toHaveBeenCalledTimes(3);
  });

  it("records a failure for the Usage page and rethrows", async () => {
    fetchRemaining.mockRejectedValue(new Error("offline"));

    await expect(lookUpUsageRemaining({ now: NOW })).rejects.toThrow("offline");
    expect(getCachedUsageRemainingError()).toBe("offline");
  });

  it("keeps the figures it had when a refresh fails, and does not retry on the next mount", async () => {
    fetchRemaining.mockResolvedValue(remaining("2026-10-04T07:50:00Z"));
    const held = await lookUpUsageRemaining({ now: NOW });
    expect(fetchRemaining).toHaveBeenCalledOnce();

    // Nine minutes on the read is stale; the refresh fails.
    fetchRemaining.mockRejectedValue(new Error("offline"));
    await expect(lookUpUsageRemaining({ now: NOW + 9 * 60_000 })).rejects.toThrow("offline");
    expect(getCachedUsageRemaining()).toBe(held);
    expect(getCachedUsageRemainingError()).toBe("offline");

    // The next chat that mounts gets the held figures without asking again.
    expect(await lookUpUsageRemaining({ now: NOW + 9 * 60_000 + 5_000 })).toBe(held);
    expect(fetchRemaining).toHaveBeenCalledTimes(2);

    // Pressing the chip may try again once the manual cooldown has passed.
    fetchRemaining.mockResolvedValue(remaining("2026-10-04T08:10:00Z", 40));
    const fresh = await lookUpUsageRemaining({ manual: true, now: NOW + 9 * 60_000 + 40_000 });
    expect(fresh).not.toBe(held);
    expect(fetchRemaining).toHaveBeenCalledTimes(3);
  });

  it("does not ask the accounts again on every mount while the first read keeps failing", async () => {
    fetchRemaining.mockRejectedValue(new Error("offline"));
    await expect(lookUpUsageRemaining({ now: NOW })).rejects.toThrow("offline");

    await expect(lookUpUsageRemaining({ now: NOW + 10_000 })).rejects.toThrow("a moment ago");
    expect(fetchRemaining).toHaveBeenCalledOnce();
  });
});

describe("summarizeProviderRemaining", () => {
  it("picks the tightest window of a subscription plan", () => {
    const summary = summarizeProviderRemaining(remaining("x", 12), "claude");

    expect(summary?.tightest.id).toBe("5h");
    expect(summary?.planLabel).toBe("Max");
    expect(summary?.windows).toHaveLength(2);
  });

  it("is null for a provider with no plan windows, or no read yet", () => {
    expect(summarizeProviderRemaining(remaining("x"), "codex")).toBeNull();
    expect(summarizeProviderRemaining(remaining("x"), "grok")).toBeNull();
    expect(summarizeProviderRemaining(null, "claude")).toBeNull();
  });
});

describe("figures held across a failed account", () => {
  beforeEach(() => resetLedgerPageStateForTests());

  const failed = (fetchedAt: string): UsageRemaining => ({
    fetchedAt,
    providers: [
      { provider: "claude", kind: "error", planLabel: null, message: "expired", messageUrl: null, windows: [] },
      { provider: "codex", kind: "api_key", planLabel: null, message: null, messageUrl: null, windows: [] }
    ]
  });

  it("falls back to the last windows an account reported, with the time they were true", () => {
    setCachedUsageRemaining(remaining("2026-10-04T07:00:00Z", 30), null);
    const failedRead = failed("2026-10-04T08:00:00Z");
    setCachedUsageRemaining(failedRead, null);

    const held = summarizeProviderWithHeld(failedRead, "claude");
    expect(held?.summary.tightest.remainingPercent).toBe(30);
    expect(held?.asOf).toBe("2026-10-04T07:00:00Z");
    // The shared cache still carries the error row, which the Usage page explains.
    expect(getCachedUsageRemaining()?.providers[0]?.kind).toBe("error");
  });

  it("holds nothing for an account that is not failing, or that never reported", () => {
    setCachedUsageRemaining(remaining("2026-10-04T07:00:00Z"), null);
    const read = failed("2026-10-04T08:00:00Z");
    setCachedUsageRemaining(read, null);

    expect(summarizeProviderWithHeld(read, "codex")).toBeNull();
    expect(summarizeProviderWithHeld(read, "grok")).toBeNull();
  });

  it("keeps the held cache when a whole read fails through the shared recorder", () => {
    const good = remaining("2026-10-04T07:00:00Z", 30);
    setCachedUsageRemaining(good, null);

    recordUsageRemainingFailure("offline", NOW);

    expect(getCachedUsageRemaining()).toBe(good);
    expect(getCachedUsageRemainingError()).toBe("offline");
  });

  it("calls figures old after the stale window and not before", () => {
    expect(remainingFiguresAreOld("2026-10-04T07:56:00Z", NOW)).toBe(false);
    expect(remainingFiguresAreOld("2026-10-04T07:50:00Z", NOW)).toBe(true);
    expect(remainingFiguresAreOld("not a date", NOW)).toBe(false);
  });
});
