// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { readLogBuffer, resetLogBufferForTesting } from "./logger.js";
import {
  __resetUnknownModelLog,
  costOf,
  MODEL_PRICING,
  normalizeModelId,
  PROVIDER_MODEL_DEFAULTS,
  PROVIDER_MODELS,
  type UsageCounts
} from "./providerModels.js";

const million: UsageCounts = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };

describe("PROVIDER_MODEL_DEFAULTS", () => {
  // The CLAUDE.md "Critical conventions" section documents these defaults. If
  // a maintainer changes the constant they need to update the doc too — this
  // test is the tripwire.
  it("matches the documented launch defaults (Claude Haiku 4.5 / Codex Spark medium)", () => {
    expect(PROVIDER_MODEL_DEFAULTS.claude).toMatchObject({
      modelId: "claude-haiku-4-5",
      launchMode: "structured-json"
    });
    expect(PROVIDER_MODEL_DEFAULTS.codex).toMatchObject({
      modelId: "gpt-5.3-codex-spark",
      reasoningEffort: "medium",
      launchMode: "structured-json"
    });
  });
});

describe("normalizeModelId", () => {
  it("strips a trailing -YYYYMMDD date suffix", () => {
    expect(normalizeModelId("claude-sonnet-4-6-20250101")).toBe("claude-sonnet-4-6");
    expect(normalizeModelId("claude-3-5-haiku-20241022")).toBe("claude-3-5-haiku");
  });

  it("leaves bare ids untouched", () => {
    expect(normalizeModelId("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(normalizeModelId("gpt-5.4-codex")).toBe("gpt-5.4-codex");
    expect(normalizeModelId("gpt-5.5")).toBe("gpt-5.5");
  });

  it("does not strip non-date trailing suffixes", () => {
    expect(normalizeModelId("gpt-5.4-codex")).toBe("gpt-5.4-codex");
  });
});

describe("costOf — golden fixtures", () => {
  beforeEach(() => __resetUnknownModelLog());

  it("prices Opus 4.7 across all four buckets", () => {
    const usage: UsageCounts = {
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 1_000_000
    };
    // 5 + 25 + 0.5 + 6.25 = 36.75
    expect(costOf(usage, "claude-opus-4-7")).toBeCloseTo(36.75, 9);
  });

  it("prices Sonnet 4.6 input-only at $3/M", () => {
    expect(costOf(million, "claude-sonnet-4-6")).toBeCloseTo(3.0, 9);
  });

  it("prices Haiku 4.5 input-only at $1/M", () => {
    expect(costOf(million, "claude-haiku-4-5")).toBeCloseTo(1.0, 9);
  });

  it("prices GPT-5.5 input-only at $5/M", () => {
    expect(costOf(million, "gpt-5.5")).toBeCloseTo(5.0, 9);
  });

  it("prices o4-mini input-only at $1.1/M", () => {
    expect(costOf(million, "o4-mini")).toBeCloseTo(1.1, 9);
  });

  it("strips date suffixes before pricing lookup", () => {
    const suffixed = costOf(million, "claude-sonnet-4-6-20250101");
    const bare = costOf(million, "claude-sonnet-4-6");
    expect(suffixed).toBe(bare);
    expect(suffixed).toBeCloseTo(3.0, 9);
  });
});

describe("costOf — unknown model", () => {
  beforeEach(() => {
    __resetUnknownModelLog();
    resetLogBufferForTesting();
  });

  it("returns 0 and does not throw", () => {
    expect(costOf(million, "gpt-99-ultra")).toBe(0);
  });

  it("logs the unknown model id exactly once", () => {
    costOf(million, "gpt-99-ultra");
    costOf(million, "gpt-99-ultra");
    costOf({ input: 5, output: 5, cacheRead: 0, cacheWrite: 0 }, "gpt-99-ultra");
    const warns = readLogBuffer().filter((entry) => entry.scope === "pricing");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.message).toBe("unknown model id");
    expect(warns[0]?.fields.modelId).toBe("gpt-99-ultra");
  });
});

describe("MODEL_PRICING coverage", () => {
  it("ships entries for the launch-default model ids", () => {
    expect(MODEL_PRICING["claude-sonnet-4-6"]).toBeDefined();
    expect(MODEL_PRICING["claude-haiku-4-5"]).toBeDefined();
    expect(MODEL_PRICING["claude-opus-4-7"]).toBeDefined();
    expect(MODEL_PRICING["gpt-5.5"]).toBeDefined();
    expect(MODEL_PRICING["gpt-5.4-codex"]).toBeDefined();
  });

  // audit-2026-05-17 L4 — drift tripwire: a new modelId added to
  // PROVIDER_MODELS without a matching MODEL_PRICING entry would otherwise
  // silently surface as $0 cost in the UI.
  it("covers every modelId in PROVIDER_MODELS", () => {
    for (const [provider, options] of Object.entries(PROVIDER_MODELS)) {
      for (const option of options) {
        const key = normalizeModelId(option.modelId);
        expect(MODEL_PRICING[key], `${provider}.${option.modelId}`).toBeDefined();
      }
    }
  });

  it("covers every modelId in PROVIDER_MODEL_DEFAULTS", () => {
    for (const [provider, fallback] of Object.entries(PROVIDER_MODEL_DEFAULTS)) {
      const key = normalizeModelId(fallback.modelId);
      expect(MODEL_PRICING[key], `${provider}.default.${fallback.modelId}`).toBeDefined();
    }
  });

  it("never has negative rates", () => {
    for (const [model, price] of Object.entries(MODEL_PRICING)) {
      expect(price.input, model).toBeGreaterThanOrEqual(0);
      expect(price.output, model).toBeGreaterThanOrEqual(0);
      expect(price.cacheRead, model).toBeGreaterThanOrEqual(0);
      expect(price.cacheWrite, model).toBeGreaterThanOrEqual(0);
    }
  });
});
