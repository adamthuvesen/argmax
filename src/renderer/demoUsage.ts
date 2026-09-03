import type {
  ProviderId,
  UsageDayRow,
  UsageModelRow,
  UsageProviderSummary,
  UsageSeriesPoint,
  UsageSummary,
  UsageSummaryInput,
  UsageTokenTotals
} from "../shared/types.js";

/**
 * Demo usage for the browser-preview boot, where there is no Rust backend to
 * scan anything. Deterministic: the same window always yields the same
 * numbers, so a screenshot diff is a real change rather than fresh noise.
 *
 * Like `demoSnapshot`, this module is only ever reached through a dynamic
 * import from the no-bridge path, so Vite keeps it out of the packaged
 * renderer bundle.
 */

/** Cheap deterministic noise. Same seed, same series, every run. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface DemoProvider {
  provider: ProviderId;
  /** Mean dollars per bucket before the weekly rhythm and the spike. */
  base: number;
  /** Dollars per million processed tokens, used to back tokens out of cost. */
  usdPerMillion: number;
}

const DEMO_PROVIDERS: readonly DemoProvider[] = [
  { provider: "claude", base: 41, usdPerMillion: 0.62 },
  { provider: "codex", base: 26, usdPerMillion: 0.44 },
  { provider: "opencode", base: 9.5, usdPerMillion: 0.21 },
  { provider: "grok", base: 2.6, usdPerMillion: 0.17 }
];

/** The one day the fixture leans on: a long weekend of migration work. */
const SPIKE_AT = 0.74;

function bucketCount(window: UsageSummary["window"]): number {
  if (window === "24h") return 24;
  return window === "7d" ? 7 : 30;
}

function shapeAt(index: number, count: number, provider: DemoProvider, rand: () => number): number {
  const position = count <= 1 ? 0 : index / (count - 1);
  // A working week: quiet at the ends, busy in the middle.
  const weekly = 0.72 + 0.42 * Math.sin(position * Math.PI * (count > 24 ? 4 : 2.1));
  const spike = 1 + 2.6 * Math.exp(-(((position - SPIKE_AT) / 0.035) ** 2));
  const jitter = 0.78 + rand() * 0.5;
  // Ramps toward the recent end, then eases off over the last few buckets so
  // the busiest point is inside the window rather than sitting on its edge.
  const ramp = 0.55 + 0.75 * position - 0.9 * Math.max(0, position - 0.86) ** 1.4;
  return provider.base * weekly * spike * jitter * ramp;
}

function emptyTokens(): UsageTokenTotals {
  return { inputUncached: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
}

function addTokens(into: UsageTokenTotals, add: UsageTokenTotals): void {
  into.inputUncached += add.inputUncached;
  into.cacheRead += add.cacheRead;
  into.cacheWrite += add.cacheWrite;
  into.output += add.output;
  into.reasoning += add.reasoning;
}

/** Split a bucket's dollars into a plausible token mix. */
function tokensFor(costUsd: number, provider: DemoProvider): UsageTokenTotals {
  const processed = Math.round((costUsd / provider.usdPerMillion) * 1_000_000);
  const output = Math.round(processed * 0.09);
  return {
    inputUncached: Math.round(processed * 0.11),
    cacheRead: Math.round(processed * 0.68),
    cacheWrite: processed - Math.round(processed * 0.11) - Math.round(processed * 0.68) - output,
    output,
    reasoning: Math.round(output * 0.42)
  };
}

function processed(tokens: UsageTokenTotals): number {
  return tokens.inputUncached + tokens.cacheRead + tokens.cacheWrite + tokens.output;
}

const MODELS: ReadonlyArray<{ provider: ProviderId; modelId: string; weight: number; unpriced?: boolean }> = [
  { provider: "claude", modelId: "claude-opus-5", weight: 0.66 },
  { provider: "claude", modelId: "claude-haiku-4-5", weight: 0.34 },
  { provider: "codex", modelId: "gpt-5.6-terra", weight: 0.81 },
  { provider: "codex", modelId: "codex-auto-review", weight: 0.19, unpriced: true },
  { provider: "opencode", modelId: "opencode-go/qwen3-coder", weight: 1 },
  { provider: "grok", modelId: "grok-code-fast-1", weight: 1 }
];

/**
 * `?usage=scanning` and `?usage=empty` put the page into its two other
 * states from the URL, so a screenshot run can capture them without a
 * backend and without a test double.
 */
function demoMode(): "normal" | "scanning" | "empty" {
  if (typeof window === "undefined") return "normal";
  const flag = new URLSearchParams(window.location.search).get("usage");
  return flag === "scanning" || flag === "empty" ? flag : "normal";
}

export function demoUsageSummary(input: UsageSummaryInput): UsageSummary {
  const mode = demoMode();
  const count = bucketCount(input.window);
  const hourly = input.window === "24h";
  const bucketMs = hourly ? 3_600_000 : 86_400_000;
  // A fixed calendar date rather than a fixed instant: day buckets are cut on
  // local midnight, so anchoring in UTC would put the last bucket a day off
  // the range label everywhere east of Greenwich.
  const end = new Date(2026, 8, 3, 0, 0, 0).getTime();
  const rangeStart = end - count * bucketMs;

  const scan: UsageSummary["scan"] =
    mode === "scanning"
      ? { phase: "scanning", filesTotal: 5312, filesDone: 1974, lastCompletedAt: null, pricingAsOf: "2026-09-01" }
      : {
          phase: "idle",
          filesTotal: 5312,
          filesDone: 5312,
          lastCompletedAt: new Date(end - 240_000).toISOString(),
          pricingAsOf: "2026-09-01"
        };

  const base: UsageSummary = {
    window: input.window,
    timeZone: input.timeZone,
    rangeStart: new Date(rangeStart).toISOString(),
    rangeEnd: new Date(end).toISOString(),
    resolution: hourly ? "hour" : "day",
    scan,
    sessions: 0,
    tokens: emptyTokens(),
    costUsd: 0,
    cacheSavingsUsd: 0,
    costSource: "list_price",
    providers: [],
    series: [],
    models: [],
    days: []
  };

  const cursorRow: UsageProviderSummary = {
    provider: "cursor",
    available: false,
    sessions: 0,
    tokens: emptyTokens(),
    costUsd: 0,
    cacheSavingsUsd: 0,
    costSource: "unpriced"
  };

  if (mode === "empty") {
    return { ...base, providers: [cursorRow] };
  }

  const rand = mulberry32(0x2026_0903 ^ count);
  const perProvider = new Map<ProviderId, { cost: number; tokens: UsageTokenTotals }>();
  const series: UsageSeriesPoint[] = [];
  const days: UsageDayRow[] = [];

  for (let index = 0; index < count; index += 1) {
    const bucketStart = new Date(rangeStart + index * bucketMs).toISOString();
    const values = DEMO_PROVIDERS.map((provider) => {
      const costUsd = Math.round(shapeAt(index, count, provider, rand) * 100) / 100;
      const tokens = tokensFor(costUsd, provider);
      const carry = perProvider.get(provider.provider) ?? { cost: 0, tokens: emptyTokens() };
      carry.cost += costUsd;
      addTokens(carry.tokens, tokens);
      perProvider.set(provider.provider, carry);
      return { provider: provider.provider, costUsd, tokens: processed(tokens) };
    });
    series.push({ bucketStart, values });
    const dayTokens = emptyTokens();
    for (const provider of DEMO_PROVIDERS) {
      const value = values.find((entry) => entry.provider === provider.provider);
      if (value) addTokens(dayTokens, tokensFor(value.costUsd, provider));
    }
    days.push({
      bucketStart,
      sessions: 6 + Math.round(rand() * 9),
      tokens: dayTokens,
      costUsd: Math.round(values.reduce((sum, value) => sum + value.costUsd, 0) * 100) / 100,
      costSource: "list_price"
    });
  }

  const providers: UsageProviderSummary[] = DEMO_PROVIDERS.map((provider, order) => {
    const carry = perProvider.get(provider.provider) ?? { cost: 0, tokens: emptyTokens() };
    return {
      provider: provider.provider,
      available: true,
      sessions: Math.round(carry.cost / (4 + order * 2.5)),
      tokens: carry.tokens,
      costUsd: Math.round(carry.cost * 100) / 100,
      // Cache-heavy agent traffic saves on the order of what it spends.
      cacheSavingsUsd: Math.round(carry.cost * 1.25 * 100) / 100,
      costSource: provider.provider === "codex" ? "mixed" : "list_price"
    };
  });
  providers.push(cursorRow);

  const totals = emptyTokens();
  for (const row of providers) addTokens(totals, row.tokens);
  const costUsd = Math.round(providers.reduce((sum, row) => sum + row.costUsd, 0) * 100) / 100;

  const models: UsageModelRow[] = MODELS.map((model) => {
    const row = providers.find((entry) => entry.provider === model.provider);
    const scale = model.weight;
    const tokens: UsageTokenTotals = {
      inputUncached: Math.round((row?.tokens.inputUncached ?? 0) * scale),
      cacheRead: Math.round((row?.tokens.cacheRead ?? 0) * scale),
      cacheWrite: Math.round((row?.tokens.cacheWrite ?? 0) * scale),
      output: Math.round((row?.tokens.output ?? 0) * scale),
      reasoning: Math.round((row?.tokens.reasoning ?? 0) * scale)
    };
    return {
      provider: model.provider,
      modelId: model.modelId,
      sessions: Math.max(1, Math.round((row?.sessions ?? 0) * scale)),
      tokens,
      // An unpriced model counts tokens and claims no dollars — the case the
      // page has to render without printing a confident $0.
      costUsd: model.unpriced ? 0 : Math.round((row?.costUsd ?? 0) * scale * 100) / 100,
      costSource: model.unpriced ? "unpriced" : "list_price"
    };
  });

  return {
    ...base,
    sessions: providers.reduce((sum, row) => sum + row.sessions, 0),
    tokens: totals,
    costUsd,
    cacheSavingsUsd: Math.round(providers.reduce((sum, row) => sum + row.cacheSavingsUsd, 0) * 100) / 100,
    costSource: "mixed",
    providers,
    series,
    models,
    days
  };
}
