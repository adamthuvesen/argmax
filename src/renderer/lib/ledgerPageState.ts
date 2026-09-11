import type { ProviderId, UsageRemaining, UsageSummary, UsageWindow } from "../../shared/types.js";
import type { ActivityMetric } from "../components/activity/activityPresentation.js";
import type { ActivitySummary, ActivityWindow } from "../components/activity/activityContract.js";
import type { UsageMetric } from "../components/usage/usagePresentation.js";

/** UI choices that should survive leaving the page and coming back. */
export type UsageUiState = {
  usageWindow: UsageWindow;
  metric: UsageMetric;
  provider: ProviderId | null;
};

export type ActivityUiState = {
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
let usageRemaining: UsageRemaining | null = null;
let usageRemainingError: string | null = null;
/** Once the remaining read has settled once, later opens must not skeleton for it. */
let usageRemainingSettled = false;

const activitySummaries = new Map<string, ActivitySummary>();

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
  return usageSummaries.get(usageSummaryKey(window, provider, timeZone)) ?? null;
}

export function setCachedUsageSummary(
  window: UsageWindow,
  provider: ProviderId | null,
  timeZone: string,
  summary: UsageSummary
): void {
  usageSummaries.set(usageSummaryKey(window, provider, timeZone), summary);
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
  return activitySummaries.get(activitySummaryKey(window, projectId, timeZone)) ?? null;
}

export function setCachedActivitySummary(
  window: ActivityWindow,
  projectId: string | null,
  timeZone: string,
  summary: ActivitySummary
): void {
  activitySummaries.set(activitySummaryKey(window, projectId, timeZone), summary);
}

/** Test-only: clears cached ledger pages between cases. */
export function resetLedgerPageStateForTests(): void {
  usageUi = { usageWindow: "30d", metric: "cost", provider: null };
  activityUi = { activityWindow: "30d", metric: "commits", projectId: null };
  usageSummaries.clear();
  usageRemaining = null;
  usageRemainingError = null;
  usageRemainingSettled = false;
  activitySummaries.clear();
}
