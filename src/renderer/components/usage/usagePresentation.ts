import type { ProviderId, UsageProviderSummary, UsageSummary } from "../../../shared/types.js";
import { PROVIDER_DISPLAY_NAMES } from "../../../shared/providerModels.js";

/**
 * The order providers are introduced in: the two that carry most of the
 * spend first, then the rest, then the one with no local usage source. A
 * provider's colour follows its identity, never its rank, so a window that
 * reorders the rows never repaints them.
 */
export const USAGE_PROVIDER_ORDER: readonly ProviderId[] = [
  "claude",
  "codex",
  "cursor",
  "opencode",
  "grok"
];

/** The series colour token for a provider. Declared per theme in tokens.css. */
export function providerColorVar(provider: ProviderId): string {
  return `var(--usage-${provider})`;
}

export function providerLabel(provider: ProviderId): string {
  return PROVIDER_DISPLAY_NAMES[provider];
}

/** The metric the page is showing. Cost is dollars; tokens is processed tokens. */
export type UsageMetric = "cost" | "tokens";

/** Processed tokens: uncached input + cache reads + cache writes + output. */
export function processedTokens(tokens: UsageSummary["tokens"]): number {
  return tokens.inputUncached + tokens.cacheRead + tokens.cacheWrite + tokens.output;
}

/** The figure a row contributes to the active metric. */
export function providerValue(row: UsageProviderSummary, metric: UsageMetric): number {
  return metric === "cost" ? row.costUsd : processedTokens(row.tokens);
}

/**
 * Rows in reading order: the biggest contributor first, then down, with the
 * providers that have no local usage source parked at the bottom — a row
 * that can never carry a number does not belong among ranked ones.
 */
export function orderedProviderRows(
  providers: readonly UsageProviderSummary[],
  metric: UsageMetric
): UsageProviderSummary[] {
  const rank = new Map(USAGE_PROVIDER_ORDER.map((id, index) => [id, index]));
  return [...providers].sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    const delta = providerValue(b, metric) - providerValue(a, metric);
    if (delta !== 0) return delta;
    return (rank.get(a.provider) ?? 99) - (rank.get(b.provider) ?? 99);
  });
}

/**
 * Providers the chart draws, in canonical order. A provider with no local
 * source and a provider that spent nothing in the window both draw a flat
 * zero line, which is noise — the chart carries only what moved.
 */
export function chartedProviders(
  summary: UsageSummary,
  metric: UsageMetric
): ProviderId[] {
  const moved = new Set<ProviderId>();
  for (const point of summary.series) {
    for (const value of point.values) {
      const amount = metric === "cost" ? value.costUsd : value.tokens;
      if (amount > 0) moved.add(value.provider);
    }
  }
  return USAGE_PROVIDER_ORDER.filter((provider) => moved.has(provider));
}

/**
 * Share of the window's total. Cost shares are computed against the priced
 * total only: an unpriced model contributes tokens but claims no dollars, so
 * folding its $0 into the denominator would understate everyone else.
 */
export function shareOfTotal(value: number, total: number): number | null {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return null;
  return value / total;
}

/** A model row the pricing table does not know: tokens counted, no dollars claimed. */
export function isUnpriced(costSource: UsageSummary["costSource"]): boolean {
  return costSource === "unpriced";
}
