import type {
  UsageProviderSummary,
  UsageSummary,
  UsageSummaryInput,
  UsageTokenTotals
} from "../../shared/types.js";

/**
 * Usage fixture for App integration tests: three days, two providers with
 * numbers, Cursor carrying the "no local source" case, and one model the
 * pricing table does not know. Small enough to assert exact strings against.
 */

function tokens(inputUncached: number, cacheRead: number, cacheWrite: number, output: number): UsageTokenTotals {
  return { inputUncached, cacheRead, cacheWrite, output, reasoning: Math.round(output / 2) };
}

function scaleTokens(source: UsageTokenTotals, factor: number): UsageTokenTotals {
  return {
    inputUncached: Math.round(source.inputUncached * factor),
    cacheRead: Math.round(source.cacheRead * factor),
    cacheWrite: Math.round(source.cacheWrite * factor),
    output: Math.round(source.output * factor),
    reasoning: Math.round(source.reasoning * factor)
  };
}

const claudeRow: UsageProviderSummary = {
  provider: "claude",
  available: true,
  sessions: 12,
  tokens: tokens(200_000, 1_200_000, 90_000, 60_000),
  costUsd: 60,
  cacheSavingsUsd: 3.25,
  costSource: "list_price"
};

const codexRow: UsageProviderSummary = {
  provider: "codex",
  available: true,
  sessions: 5,
  tokens: tokens(80_000, 400_000, 20_000, 30_000),
  costUsd: 40,
  cacheSavingsUsd: 1.1,
  costSource: "list_price"
};

const cursorRow: UsageProviderSummary = {
  provider: "cursor",
  available: false,
  sessions: 0,
  tokens: tokens(0, 0, 0, 0),
  costUsd: 0,
  cacheSavingsUsd: 0,
  costSource: "unpriced"
};

export function usageSummaryFixture(overrides: Partial<UsageSummary> = {}): UsageSummary {
  const base: UsageSummary = {
    window: "30d",
    provider: null,
    timeZone: "UTC",
    rangeStart: "2026-08-31T00:00:00Z",
    rangeEnd: "2026-09-03T00:00:00Z",
    resolution: "day",
    scan: {
      phase: "idle",
      filesTotal: 120,
      filesDone: 120,
      lastCompletedAt: "2026-09-02T23:58:00Z",
      pricingAsOf: "2026-09-01"
    },
    sessions: 17,
    tokens: tokens(280_000, 1_600_000, 110_000, 90_000),
    costUsd: 100,
    cacheSavingsUsd: 4.35,
    costSource: "list_price",
    // A quieter window before this one, so the comparison reads as $100 up
    // 34% on $74.50.
    previous: {
      costUsd: 74.5,
      tokens: tokens(210_000, 1_180_000, 82_000, 66_000),
      sessions: 13
    },
    providers: [claudeRow, codexRow, cursorRow],
    series: [
      {
        bucketStart: "2026-08-31T00:00:00Z",
        values: [
          { provider: "claude", costUsd: 10, tokens: 400_000 },
          { provider: "codex", costUsd: 8, tokens: 150_000 }
        ]
      },
      {
        bucketStart: "2026-09-01T00:00:00Z",
        values: [
          { provider: "claude", costUsd: 30, tokens: 800_000 },
          { provider: "codex", costUsd: 12, tokens: 200_000 }
        ]
      },
      {
        bucketStart: "2026-09-02T00:00:00Z",
        values: [
          { provider: "claude", costUsd: 20, tokens: 350_000 },
          { provider: "codex", costUsd: 20, tokens: 180_000 }
        ]
      }
    ],
    models: [
      {
        provider: "claude",
        modelId: "claude-opus-5",
        sessions: 9,
        tokens: tokens(180_000, 1_000_000, 80_000, 50_000),
        costUsd: 60,
        costSource: "list_price"
      },
      {
        provider: "codex",
        modelId: "gpt-5.6-terra",
        sessions: 4,
        tokens: tokens(70_000, 350_000, 18_000, 26_000),
        costUsd: 40,
        costSource: "list_price"
      },
      {
        provider: "codex",
        modelId: "codex-auto-review",
        sessions: 1,
        tokens: tokens(10_000, 50_000, 2_000, 4_000),
        costUsd: 0,
        costSource: "unpriced"
      }
    ],
    days: [
      {
        bucketStart: "2026-08-31T00:00:00Z",
        sessions: 4,
        tokens: tokens(60_000, 300_000, 20_000, 20_000),
        costUsd: 18,
        costSource: "list_price"
      },
      {
        bucketStart: "2026-09-01T00:00:00Z",
        sessions: 7,
        tokens: tokens(120_000, 700_000, 50_000, 40_000),
        costUsd: 42,
        costSource: "list_price"
      },
      {
        bucketStart: "2026-09-02T00:00:00Z",
        sessions: 6,
        tokens: tokens(100_000, 600_000, 40_000, 30_000),
        costUsd: 40,
        costSource: "list_price"
      }
    ]
  };
  return { ...base, ...overrides };
}

/**
 * The window the caller asked for, with the range the backend would return
 * for it. The zone stays pinned to UTC rather than echoing the host's, so a
 * date label in an assertion means the same thing on every machine.
 */
export function usageSummaryFor(input: UsageSummaryInput): UsageSummary {
  const ranges: Record<UsageSummaryInput["window"], Partial<UsageSummary>> = {
    "24h": {
      rangeStart: "2026-09-02T00:00:00Z",
      rangeEnd: "2026-09-03T00:00:00Z",
      resolution: "hour"
    },
    "7d": { rangeStart: "2026-08-27T00:00:00Z", rangeEnd: "2026-09-03T00:00:00Z" },
    "30d": { rangeStart: "2026-08-04T00:00:00Z", rangeEnd: "2026-09-03T00:00:00Z" }
  };
  const summary = usageSummaryFixture({ window: input.window, ...ranges[input.window] });
  const provider = input.provider ?? null;
  if (!provider) return summary;
  // Narrowed the way the backend narrows: the headline is the provider's
  // row, the series and models keep only its values, the rows keep everyone.
  const row = summary.providers.find((entry) => entry.provider === provider);
  if (!row) throw new Error(`fixture has no provider row for ${provider}`);
  // The comparison narrows too: the provider's share of the earlier window.
  const costShare = row.costUsd / summary.costUsd;
  return {
    ...summary,
    provider,
    sessions: row.sessions,
    tokens: row.tokens,
    costUsd: row.costUsd,
    cacheSavingsUsd: row.cacheSavingsUsd,
    costSource: row.costSource,
    previous: summary.previous && {
      costUsd: Math.round(summary.previous.costUsd * costShare * 100) / 100,
      tokens: scaleTokens(summary.previous.tokens, costShare),
      sessions: Math.round(summary.previous.sessions * costShare)
    },
    series: summary.series.map((point) => ({
      ...point,
      values: point.values.filter((value) => value.provider === provider)
    })),
    models: summary.models.filter((model) => model.provider === provider),
    days: summary.days.map((day) => {
      const share = summary.series.find((point) => point.bucketStart === day.bucketStart);
      const own = share?.values.find((value) => value.provider === provider);
      return { ...day, sessions: Math.ceil(day.sessions / 2), costUsd: own?.costUsd ?? 0 };
    })
  };
}
