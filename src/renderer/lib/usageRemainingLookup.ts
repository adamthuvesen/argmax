import type { ProviderId, UsageLimitWindow, UsageRemaining } from "../../shared/types.js";
import {
  getCachedUsageRemaining,
  getLastGoodProviderRow,
  getUsageRemainingFailedAt,
  recordUsageRemainingFailure,
  requestUsageRemaining
} from "./ledgerPageState.js";

/**
 * How long a remaining read stands before a lookup refreshes it. The figures
 * come from provider accounts over the network and Claude's endpoint
 * rate-limits, so opening a menu twice in a minute must not fetch twice.
 */
export const REMAINING_STALE_AFTER_MS = 5 * 60_000;
/** A lookup the user asks for by hand still waits this long after the last read. */
const MANUAL_REFRESH_COOLDOWN_MS = 30_000;

export async function fetchUsageRemaining(): Promise<UsageRemaining> {
  const api = globalThis.window?.argmax;
  if (api?.usage?.remaining) return api.usage.remaining();
  // No bridge (browser preview / screenshot harness): the demo fixture is
  // dynamic-imported so it never reaches the packaged bundle.
  const { demoUsageRemaining } = await import("../demoUsage.js");
  return demoUsageRemaining();
}

function ageMs(remaining: UsageRemaining, now: number): number {
  const fetchedAt = Date.parse(remaining.fetchedAt);
  return Number.isFinite(fetchedAt) ? now - fetchedAt : Number.POSITIVE_INFINITY;
}

export function isUsageRemainingStale(remaining: UsageRemaining | null, now: number): boolean {
  return !remaining || ageMs(remaining, now) > REMAINING_STALE_AFTER_MS;
}

/**
 * Look up how much of each plan is left, for the composer. It reads the
 * ledger's own cache and joins a read already in flight, so any number of
 * composers asking at once cost one fetch, and it never starts a model turn or
 * resumes anything: it is a read of the accounts' reported limits. `manual`
 * is the user pressing the chip, which may refresh a read that is not yet
 * stale, but not one taken a moment ago.
 */
export async function lookUpUsageRemaining(
  options: { manual?: boolean; now?: number } = {}
): Promise<UsageRemaining> {
  const now = options.now ?? Date.now();
  const cached = getCachedUsageRemaining();
  if (cached) {
    const age = ageMs(cached, now);
    const reuse = options.manual ? age <= MANUAL_REFRESH_COOLDOWN_MS : age <= REMAINING_STALE_AFTER_MS;
    if (reuse) return cached;
  }
  // After a failed read, wait out the stale window before asking the accounts
  // again on a mount; only a press of the chip may try sooner. Without this,
  // every chat switch would repeat a fetch that has just failed.
  const failedAt = getUsageRemainingFailedAt();
  if (
    failedAt !== null &&
    now - failedAt < (options.manual ? MANUAL_REFRESH_COOLDOWN_MS : REMAINING_STALE_AFTER_MS)
  ) {
    if (cached) return cached;
    throw new Error("Remaining usage could not be read a moment ago.");
  }
  try {
    return await requestUsageRemaining(fetchUsageRemaining);
  } catch (cause) {
    recordUsageRemainingFailure(
      cause instanceof Error ? cause.message : "Could not read remaining usage.",
      now
    );
    throw cause;
  }
}

export interface ProviderRemainingSummary {
  provider: ProviderId;
  planLabel: string | null;
  /** The window with the least left: the one that stops the next message. */
  tightest: UsageLimitWindow;
  windows: UsageLimitWindow[];
}

/**
 * One provider's plan windows for the composer: the current read's, or, when
 * the current read has none because that account failed this time, the last
 * ones it reported, with the time of the read they came from. `asOf` is when
 * the figures were true.
 */
export function summarizeProviderWithHeld(
  remaining: UsageRemaining | null,
  provider: ProviderId
): { summary: ProviderRemainingSummary; asOf: string } | null {
  const current = summarizeProviderRemaining(remaining, provider);
  const currentRow = (remaining?.providers ?? []).find((entry) => entry.provider === provider);
  // A provider that answered with something other than an error (signed out,
  // an API key) is not "failing": it has no plan windows to hold.
  if (current) return { summary: current, asOf: remaining?.fetchedAt ?? "" };
  if (currentRow && currentRow.kind !== "error") return null;
  const held = getLastGoodProviderRow(provider);
  if (!held) return null;
  const rebuilt = summarizeProviderRemaining(
    { fetchedAt: held.fetchedAt, providers: [held.row] },
    provider
  );
  return rebuilt ? { summary: rebuilt, asOf: held.fetchedAt } : null;
}

/** Whether figures from `asOf` are old enough that the chip should say so. */
export function remainingFiguresAreOld(asOf: string, now: number): boolean {
  const at = Date.parse(asOf);
  return Number.isFinite(at) && now - at > REMAINING_STALE_AFTER_MS;
}

/** One provider's plan windows, or null when its account reported none. */
export function summarizeProviderRemaining(
  remaining: UsageRemaining | null,
  provider: ProviderId
): ProviderRemainingSummary | null {
  // Read the way the sidebar menu reads it: a bridge with no usage source
  // (a browser preview, a test double) yields nothing, not an error.
  const row = (remaining?.providers ?? []).find(
    (entry) => entry.provider === provider && entry.kind === "subscription" && entry.windows.length > 0
  );
  if (!row) return null;
  const tightest = row.windows.reduce((least, window) =>
    window.remainingPercent < least.remainingPercent ? window : least
  );
  return { provider, planLabel: row.planLabel, tightest, windows: row.windows };
}
