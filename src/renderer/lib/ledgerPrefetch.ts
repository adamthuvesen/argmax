import type { ArgmaxApi } from "../../shared/types.js";
import {
  getActivityUiState,
  getCachedActivitySummary,
  getCachedUsageSummary,
  getUsageUiState,
  setCachedActivitySummary,
  setCachedUsageRemaining,
  setCachedUsageSummary,
  usageRemainingHasSettled
} from "./ledgerPageState.js";

/** The zone day buckets are cut on. Must match the panels' hostTimeZone(). */
function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

let prefetchStarted = false;
let prefetchIdleHandle: number | null = null;
let prefetchIdleKind: "ric" | "timeout" | null = null;

/**
 * Warm the Usage and Activity ledgers after boot. The renderer schedules this
 * on an idle tick so first paint and the dashboard load stay untouched; each
 * `usage:summary` / `activity:summary` call runs its sweep on Rust's blocking
 * pool (`read_off_main`), not on the macOS main thread.
 */
export async function prefetchLedgerPages(api: ArgmaxApi): Promise<void> {
  const timeZone = hostTimeZone();
  const usageUi = getUsageUiState();
  const activityUi = getActivityUiState();

  const tasks: Array<Promise<void>> = [];

  if (!getCachedUsageSummary(usageUi.usageWindow, usageUi.provider, timeZone)) {
    tasks.push(
      api.usage
        .summary({ window: usageUi.usageWindow, provider: usageUi.provider, timeZone })
        .then((summary) => {
          setCachedUsageSummary(usageUi.usageWindow, usageUi.provider, timeZone, summary);
        })
    );
  }

  if (!getCachedActivitySummary(activityUi.activityWindow, activityUi.projectId, timeZone)) {
    tasks.push(
      api.activity
        .summary({
          window: activityUi.activityWindow,
          projectId: activityUi.projectId,
          timeZone
        })
        .then((summary) => {
          setCachedActivitySummary(
            activityUi.activityWindow,
            activityUi.projectId,
            timeZone,
            summary
          );
        })
    );
  }

  // Remaining reads four provider accounts and may take seconds; run it in
  // parallel with the local ledgers so a warm summary is not waiting on OAuth.
  if (!usageRemainingHasSettled() && api.usage.remaining) {
    tasks.push(
      api.usage
        .remaining()
        .then((remaining) => {
          setCachedUsageRemaining(remaining, null);
        })
        .catch((cause) => {
          const message =
            cause instanceof Error ? cause.message : "Could not read remaining usage.";
          setCachedUsageRemaining(null, message);
        })
    );
  }

  await Promise.all(tasks);
}

/** Warm ledgers on sidebar hover — cheap once cached, skips settled reads. */
export function warmLedgerPagesOnIntent(api: ArgmaxApi): void {
  void prefetchLedgerPages(api).catch(() => undefined);
}

/** Idle-schedule ledger prefetch once per app session. */
export function scheduleLedgerPrefetch(api: ArgmaxApi): void {
  if (prefetchStarted) return;
  prefetchStarted = true;

  const run = (): void => {
    prefetchIdleHandle = null;
    prefetchIdleKind = null;
    void prefetchLedgerPages(api).catch(() => undefined);
  };

  const idleHost = globalThis as typeof globalThis & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  };

  if (typeof idleHost.requestIdleCallback === "function") {
    prefetchIdleKind = "ric";
    prefetchIdleHandle = idleHost.requestIdleCallback(run, { timeout: 5000 });
  } else {
    prefetchIdleKind = "timeout";
    prefetchIdleHandle = globalThis.setTimeout(run, 800) as unknown as number;
  }
}

/** Test-only: allow another prefetch in the next case. */
export function resetLedgerPrefetchForTests(): void {
  if (prefetchIdleHandle !== null) {
    const idleHost = globalThis as typeof globalThis & {
      cancelIdleCallback?: (id: number) => void;
    };
    if (prefetchIdleKind === "ric" && typeof idleHost.cancelIdleCallback === "function") {
      idleHost.cancelIdleCallback(prefetchIdleHandle);
    } else {
      globalThis.clearTimeout(prefetchIdleHandle);
    }
    prefetchIdleHandle = null;
    prefetchIdleKind = null;
  }
  prefetchStarted = false;
}
