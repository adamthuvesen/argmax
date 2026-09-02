// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { readLogBuffer, resetLogBufferForTesting } from "./logger.js";
import {
  __resetUnknownModelLog,
  costOf,
  effortForModel,
  MODEL_PRICING,
  normalizeModelId,
  PROVIDER_MODEL_DEFAULTS,
  PROVIDER_MODELS,
  PROVIDER_TITLE_MODEL,
  reasoningEffortsForModel,
  type UsageCounts
} from "./providerModels.js";

const million: UsageCounts = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };

describe("PROVIDER_MODEL_DEFAULTS", () => {
  // Tripwire: launch defaults and the effort they seed. Effort comes from
  // DEFAULT_REASONING_EFFORT via modelDefaultForProvider when unset here.
  it("matches the documented launch defaults", () => {
    expect(PROVIDER_MODEL_DEFAULTS.claude).toMatchObject({
      modelId: "claude-opus-5",
      supportsReasoningEffort: true
    });
    expect(PROVIDER_MODEL_DEFAULTS.claude.reasoningEffort).toBeUndefined();
    expect(PROVIDER_MODEL_DEFAULTS.codex).toMatchObject({
      modelId: "gpt-5.6-sol",
      supportsReasoningEffort: true
    });
    expect(PROVIDER_MODEL_DEFAULTS.codex.reasoningEffort).toBeUndefined();
    expect(PROVIDER_MODEL_DEFAULTS.cursor).toMatchObject({
      modelId: "cursor-grok-4.6-medium",
      supportsReasoningEffort: true
    });
    expect(PROVIDER_MODEL_DEFAULTS.opencode).toMatchObject({
      modelId: "opencode-go/glm-5.3-flash",
      supportsReasoningEffort: true,
      reasoningEffort: "high"
    });
  });
});

describe("reasoningEffortsForModel", () => {
  it("offers Max for Cursor GPT-5.6 and Opus 5 Thinking", () => {
    expect(reasoningEffortsForModel("cursor", "gpt-5.6-sol-medium")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ]);
    expect(reasoningEffortsForModel("cursor", "claude-opus-5-thinking-medium")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ]);
  });

  // Grok Build's CLI rejects anything above xhigh outright:
  // "unknown effort level 'max'; use one of: xhigh, high, medium, low".
  it("caps Grok Build at xhigh for every model", () => {
    for (const model of PROVIDER_MODELS.grok) {
      expect(reasoningEffortsForModel("grok", model.modelId)).toEqual([
        "low",
        "medium",
        "high",
        "xhigh"
      ]);
    }
  });

  it("caps Cursor Grok and Gemini 3.8 at High", () => {
    expect(reasoningEffortsForModel("cursor", "cursor-grok-4.6-medium")).toEqual([
      "low",
      "medium",
      "high"
    ]);
    expect(reasoningEffortsForModel("cursor", "cursor-grok-4.5-medium")).toEqual([
      "low",
      "medium",
      "high"
    ]);
    expect(reasoningEffortsForModel("cursor", "gemini-3.8-flash-medium")).toEqual([
      "low",
      "medium",
      "high"
    ]);
  });

  it("offers Max and Ultra for Codex Sol/Terra, Max only for Luna", () => {
    expect(reasoningEffortsForModel("codex", "gpt-5.6-sol")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra"
    ]);
    expect(reasoningEffortsForModel("codex", "gpt-5.6-terra")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra"
    ]);
    expect(reasoningEffortsForModel("codex", "gpt-5.6-luna")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ]);
  });

  it("lists Codex models Sol → Terra → Luna", () => {
    expect(PROVIDER_MODELS.codex.map((model) => model.modelId)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna"
    ]);
  });
});

describe("normalizeModelId", () => {
  it("strips a trailing -YYYYMMDD date suffix", () => {
    expect(normalizeModelId("claude-sonnet-5-20250101")).toBe("claude-sonnet-5");
    expect(normalizeModelId("claude-haiku-4-5-20241022")).toBe("claude-haiku-4-5");
  });

  it("leaves bare ids untouched", () => {
    expect(normalizeModelId("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(normalizeModelId("gpt-5.6-sol")).toBe("gpt-5.6-sol");
  });

  it("does not strip non-date trailing suffixes", () => {
    expect(normalizeModelId("gpt-5.6-sol-medium")).toBe("gpt-5.6-sol-medium");
  });
});

describe("costOf — golden fixtures", () => {
  beforeEach(() => __resetUnknownModelLog());

  it("prices Opus 5 across all four buckets", () => {
    const usage: UsageCounts = {
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 1_000_000
    };
    // 5 + 25 + 0.5 + 6.25 = 36.75
    expect(costOf(usage, "claude-opus-5")).toBeCloseTo(36.75, 9);
  });

  it("prices stored Opus 4.8 sessions via aliases", () => {
    const usage: UsageCounts = {
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 1_000_000
    };
    expect(MODEL_PRICING["claude-opus-4-8"]).toBeUndefined();
    expect(costOf(usage, "claude-opus-4-8")).toBeCloseTo(36.75, 9);
  });

  it("prices Sonnet 5 input-only at $3/M", () => {
    expect(costOf(million, "claude-sonnet-5")).toBeCloseTo(3.0, 9);
  });

  it("prices Haiku 4.5 input-only at $1/M", () => {
    expect(costOf(million, "claude-haiku-4-5")).toBeCloseTo(1.0, 9);
  });

  it("prices GPT-5.6 Sol input-only at $5/M", () => {
    expect(costOf(million, "gpt-5.6-sol")).toBeCloseTo(5.0, 9);
  });

  it("prices GPT-5.6 Luna / Terra at published short-context rates", () => {
    expect(costOf(million, "gpt-5.6-luna")).toBeCloseTo(0.2, 9);
    expect(costOf(million, "gpt-5.6-terra")).toBeCloseTo(2.0, 9);
  });

  it("prices stored GPT-5.5 sessions via aliases", () => {
    expect(MODEL_PRICING["gpt-5.5"]).toBeUndefined();
    expect(costOf(million, "gpt-5.5")).toBeCloseTo(5.0, 9);
  });

  it("strips date suffixes before pricing lookup", () => {
    const suffixed = costOf(million, "claude-sonnet-5-20250101");
    const bare = costOf(million, "claude-sonnet-5");
    expect(suffixed).toBe(bare);
    expect(suffixed).toBeCloseTo(3.0, 9);
  });

  it("prices persisted model ids without restoring them to the model table", () => {
    expect(MODEL_PRICING["claude-sonnet-4-6"]).toBeUndefined();
    expect(MODEL_PRICING["gpt-5.4-codex"]).toBeUndefined();
    expect(MODEL_PRICING["o4-mini"]).toBeUndefined();
    expect(costOf(million, "claude-sonnet-4-6")).toBeCloseTo(3.0, 9);
    expect(costOf(million, "claude-sonnet-4-6-20250101")).toBeCloseTo(3.0, 9);
    expect(costOf(million, "gpt-5.4-codex")).toBeCloseTo(2.5, 9);
    expect(costOf(million, "o4-mini")).toBeCloseTo(1.1, 9);
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
    expect(MODEL_PRICING["claude-sonnet-5"]).toBeDefined();
    expect(MODEL_PRICING["claude-haiku-4-5"]).toBeDefined();
    expect(MODEL_PRICING["gpt-5.6-sol"]).toBeDefined();
    expect(MODEL_PRICING["claude-opus-5"]).toBeDefined();
    expect(MODEL_PRICING["cursor-grok-4.6-medium"]).toBeDefined();
    expect(MODEL_PRICING["opencode-go/glm-5.3-flash"]).toBeDefined();
  });

  // Drift tripwire: every picker model must have a matching pricing entry so
  // usage cannot silently show as $0 in the UI.
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

  it("covers every provider title model id", () => {
    for (const [provider, modelId] of Object.entries(PROVIDER_TITLE_MODEL)) {
      const key = normalizeModelId(modelId);
      expect(MODEL_PRICING[key], `${provider}.title.${modelId}`).toBeDefined();
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

describe("Grok Build pricing", () => {
  // These three token mixes and costs are verbatim from
  // `grok --output-format json` runs (grok 1.0.13). The table is only correct
  // if it reproduces what the CLI itself billed — Grok Build charges its own
  // `*-build` SKU rate, not xAI's published API price.
  it("reproduces the cost the CLI reported, to the cent fraction", () => {
    const cases: Array<[string, UsageCounts, number]> = [
      ["grok-4.6", { input: 14_740, output: 41, cacheRead: 5_760, cacheWrite: 0 }, 0.00554302],
      ["grok-4.6", { input: 20_377, output: 4_442, cacheRead: 128, cacheWrite: 0 }, 0.0114699],
      ["grok-4.6", { input: 14_838, output: 70, cacheRead: 26_240, cacheWrite: 0 }, 0.00734672],
      ["grok-4.5", { input: 20_377, output: 362, cacheRead: 128, cacheWrite: 0 }, 0.014607896]
    ];
    for (const [modelId, usage, reported] of cases) {
      expect(costOf(usage, modelId), modelId).toBeCloseTo(reported, 9);
    }
  });

  // 4.5 is the pricier SKU here, so the default and the title model must stay
  // on 4.6 — a silent flip would double every session's cost.
  it("keeps the cheaper model as the default and title model", () => {
    expect(PROVIDER_MODEL_DEFAULTS.grok.modelId).toBe("grok-4.6");
    expect(PROVIDER_TITLE_MODEL.grok).toBe("grok-4.6");
    expect(MODEL_PRICING["grok-4.6"].input).toBeLessThan(MODEL_PRICING["grok-4.5"].input);
  });
});

describe("effortForModel", () => {
  it("keeps the app-wide default effort when the model offers it", () => {
    expect(effortForModel("claude", "claude-opus-5", "ultra")).toBe("ultra");
    expect(effortForModel("codex", "gpt-5.6-luna", "max")).toBe("max");
  });

  it("falls back to Medium when the model's ladder stops lower", () => {
    // Grok Build's CLI rejects anything above xhigh, and Cursor's Gemini
    // stops at high — both land on Medium rather than the nearest ceiling.
    expect(effortForModel("grok", "grok-4.6", "ultra")).toBe("medium");
    expect(effortForModel("cursor", "gemini-3.8-flash-medium", "max")).toBe("medium");
  });

  it("clamps onto discrete variant lists that have no Medium", () => {
    expect(effortForModel("opencode", "opencode-go/glm-5.3-flash", "ultra")).toBe("low");
    expect(effortForModel("opencode", "opencode-go/kimi-k3", "low")).toBe("max");
  });

  it("defaults to Medium when no preference is given", () => {
    expect(effortForModel("claude", "claude-opus-5")).toBe("medium");
  });
});
