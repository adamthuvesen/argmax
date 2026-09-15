import type { ProviderId, UsageRemaining, UsageSummary, UsageWindow } from "../../shared/types.js";
import type { ActivityMetric } from "../components/activity/activityPresentation.js";
import type { ActivitySummary, ActivityWindow } from "../components/activity/activityContract.js";
import type { UsageMetric } from "../components/usage/usagePresentation.js";

/** UI choices that should survive leaving the page and coming back. */
type UsageUiState = {
  usageWindow: UsageWindow;
  metric: UsageMetric;
  provider: ProviderId | null;
};

type ActivityUiState = {
  activityWindow: ActivityWindow;
  metric: ActivityMetric;
  projectId: string | null;
};

let usageUi: UsageUiState = {
  usageWindow: "30d",
  metric: "cost",
  provider: null
};

let activityUi: ActivityUiState = {
  activityWindow: "30d",
  metric: "commits",
  projectId: null
};

const usageSummaries = new Map<string, UsageSummary>();
const usageSummaryRequests = new Map<string, Promise<UsageSummary>>();
let usageRemaining: UsageRemaining | null = null;
let usageRemainingError: string | null = null;
let usageRemainingRequest: Promise<UsageRemaining> | null = null;
/** Once the remaining read has settled once, later opens must not skeleton for it. */
let usageRemainingSettled = false;

const activitySummaries = new Map<string, ActivitySummary>();
const activitySummaryRequests = new Map<string, Promise<ActivitySummary>>();

/** Ledger summaries are large enough that filter exploration needs a hard bound. */
const SUMMARY_CACHE_LIMIT = 8;

function usageSummaryKey(
  window: UsageWindow,
  provider: ProviderId | null,
  timeZone: string
): string {
  return `${window}\0${provider ?? "all"}\0${timeZone}`;
}

function activitySummaryKey(
  window: ActivityWindow,
  projectId: string | null,
  timeZone: string
): string {
  return `${window}\0${projectId ?? "all"}\0${timeZone}`;
}

function isDefaultSummaryKey(key: string): boolean {
  return key.startsWith("30d\0all\0");
}

function getRecent<K, V>(cache: Map<K, V>, key: K): V | null {
  const value = cache.get(key);
  if (value === undefined) return null;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function setRecent<V>(cache: Map<string, V>, key: string, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > SUMMARY_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) return;
    const evict = isDefaultSummaryKey(oldest)
      ? Array.from(cache.keys()).find((candidate) => !isDefaultSummaryKey(candidate)) ?? oldest
      : oldest;
    cache.delete(evict);
  }
}

function clearMatchingRequest<T>(
  requests: Map<string, Promise<T>>,
  key: string,
  request: Promise<T>
): void {
  if (requests.get(key) === request) requests.delete(key);
}

export function getUsageUiState(): UsageUiState {
  return usageUi;
}

export function patchUsageUiState(patch: Partial<UsageUiState>): void {
  usageUi = { ...usageUi, ...patch };
}

export function getCachedUsageSummary(
  window: UsageWindow,
  provider: ProviderId | null,
  timeZone: string
): UsageSummary | null {
  return getRecent(usageSummaries, usageSummaryKey(window, provider, timeZone));
}

export function setCachedUsageSummary(
  window: UsageWindow,
  provider: ProviderId | null,
  timeZone: string,
  summary: UsageSummary
): void {
  setRecent(usageSummaries, usageSummaryKey(window, provider, timeZone), summary);
}

/** Join another read for the same view instead of starting a duplicate sweep. */
export function requestUsageSummary(
  window: UsageWindow,
  provider: ProviderId | null,
  timeZone: string,
  fetch: () => Promise<UsageSummary>
): Promise<UsageSummary> {
  const key = usageSummaryKey(window, provider, timeZone);
  const active = usageSummaryRequests.get(key);
  if (active) return active;

  const request = fetch().then((summary) => {
    setCachedUsageSummary(window, provider, timeZone, summary);
    return summary;
  });
  usageSummaryRequests.set(key, request);
  void request.then(
    () => clearMatchingRequest(usageSummaryRequests, key, request),
    () => clearMatchingRequest(usageSummaryRequests, key, request)
  );
  return request;
}

export function getCachedUsageRemaining(): UsageRemaining | null {
  return usageRemaining;
}

export function getCachedUsageRemainingError(): string | null {
  return usageRemainingError;
}

export function usageRemainingHasSettled(): boolean {
  return usageRemainingSettled;
}

export function setCachedUsageRemaining(
  remaining: UsageRemaining | null,
  error: string | null
): void {
  usageRemaining = remaining;
  usageRemainingError = error;
  if (remaining !== null || error !== null) {
    usageRemainingSettled = true;
  }
}

/** Remaining is one account-wide read, so every caller can share it. */
export function requestUsageRemaining(
  fetch: () => Promise<UsageRemaining>
): Promise<UsageRemaining> {
  if (usageRemainingRequest) return usageRemainingRequest;

  const request = fetch().then((remaining) => {
    setCachedUsageRemaining(remaining, null);
    return remaining;
  });
  usageRemainingRequest = request;
  void request.then(
    () => {
      if (usageRemainingRequest === request) usageRemainingRequest = null;
    },
    () => {
      if (usageRemainingRequest === request) usageRemainingRequest = null;
    }
  );
  return request;
}

export function markUsageRemainingHoldOver(): void {
  usageRemainingSettled = true;
}

export function getActivityUiState(): ActivityUiState {
  return activityUi;
}

export function patchActivityUiState(patch: Partial<ActivityUiState>): void {
  activityUi = { ...activityUi, ...patch };
}

export function getCachedActivitySummary(
  window: ActivityWindow,
  projectId: string | null,
  timeZone: string
): ActivitySummary | null {
  return getRecent(activitySummaries, activitySummaryKey(window, projectId, timeZone));
}

export function setCachedActivitySummary(
  window: ActivityWindow,
  projectId: string | null,
  timeZone: string,
  summary: ActivitySummary
): void {
  setRecent(activitySummaries, activitySummaryKey(window, projectId, timeZone), summary);
}

/** Join another read for the same view instead of walking every clone twice. */
export function requestActivitySummary(
  window: ActivityWindow,
  projectId: string | null,
  timeZone: string,
  fetch: () => Promise<ActivitySummary>
): Promise<ActivitySummary> {
  const key = activitySummaryKey(window, projectId, timeZone);
  const active = activitySummaryRequests.get(key);
  if (active) return active;

  const request = fetch().then((summary) => {
    setCachedActivitySummary(window, projectId, timeZone, summary);
    return summary;
  });
  activitySummaryRequests.set(key, request);
  void request.then(
    () => clearMatchingRequest(activitySummaryRequests, key, request),
    () => clearMatchingRequest(activitySummaryRequests, key, request)
  );
  return request;
}

/** Test-only: clears cached ledger pages between cases. */
export function resetLedgerPageStateForTests(): void {
  usageUi = { usageWindow: "30d", metric: "cost", provider: null };
  activityUi = { activityWindow: "30d", metric: "commits", projectId: null };
  usageSummaries.clear();
  usageSummaryRequests.clear();
  usageRemaining = null;
  usageRemainingError = null;
  usageRemainingRequest = null;
  usageRemainingSettled = false;
  activitySummaries.clear();
  activitySummaryRequests.clear();
}
