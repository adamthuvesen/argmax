import { BoundedSet } from "./boundedSet.js";
import type { reasoningEffortSchema } from "./ipcSchemas.js";
import { logger } from "./logger.js";
import type { ProviderId } from "./types.js";
import type { z } from "zod";

// Derived from the Zod source so the union and validator can't drift (S-004).
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export type ProviderLaunchMode = "interactive-pty" | "structured-json";

export interface ProviderModelOption {
  label: string;
  modelId: string;
  reasoningEffort?: ReasoningEffort;
  /** When true, explicitly disables model_reasoning_summary so global config can't inject it. */
  disableReasoningSummary?: boolean;
  description?: string;
  badge?: string;
}

export interface ProviderModelDefault extends ProviderModelOption {
  launchMode: ProviderLaunchMode;
}

export type ProviderModelSelection = Pick<ProviderModelOption, "label" | "modelId" | "reasoningEffort">;

export const PROVIDER_MODELS: Record<ProviderId, ProviderModelOption[]> = {
  claude: [
    { label: "Claude Opus 4.7", modelId: "claude-opus-4-7" },
    { label: "Claude Opus 4.7", modelId: "claude-opus-4-7", reasoningEffort: "low" },
    { label: "Claude Opus 4.7", modelId: "claude-opus-4-7", reasoningEffort: "medium" },
    { label: "Claude Opus 4.7", modelId: "claude-opus-4-7", reasoningEffort: "high" },
    { label: "Claude Sonnet 4.6", modelId: "claude-sonnet-4-6" },
    { label: "Claude Sonnet 4.6", modelId: "claude-sonnet-4-6", reasoningEffort: "low" },
    { label: "Claude Sonnet 4.6", modelId: "claude-sonnet-4-6", reasoningEffort: "medium" },
    { label: "Claude Sonnet 4.6", modelId: "claude-sonnet-4-6", reasoningEffort: "high" },
    { label: "Claude Haiku 4.5", modelId: "claude-haiku-4-5" },
    { label: "Claude Haiku 4.5", modelId: "claude-haiku-4-5", reasoningEffort: "low" },
    { label: "Claude Haiku 4.5", modelId: "claude-haiku-4-5", reasoningEffort: "medium" },
    { label: "Claude Haiku 4.5", modelId: "claude-haiku-4-5", reasoningEffort: "high" }
  ],
  codex: [
    { label: "Codex Spark", modelId: "gpt-5.3-codex-spark", reasoningEffort: "low", disableReasoningSummary: true },
    { label: "Codex Spark", modelId: "gpt-5.3-codex-spark", reasoningEffort: "medium", disableReasoningSummary: true },
    { label: "Codex Spark", modelId: "gpt-5.3-codex-spark", reasoningEffort: "high", disableReasoningSummary: true },
    { label: "GPT-5.5", modelId: "gpt-5.5", reasoningEffort: "low" },
    { label: "GPT-5.5", modelId: "gpt-5.5", reasoningEffort: "medium" },
    { label: "GPT-5.5", modelId: "gpt-5.5", reasoningEffort: "high" }
  ],
  cursor: [
    { label: "Cursor Composer 2", modelId: "composer-2" },
    { label: "GPT-5.5 (Cursor)", modelId: "gpt-5.5-medium" },
    { label: "Claude Opus 4.7 (Cursor)", modelId: "claude-opus-4-7-medium" }
  ]
};

export const PROVIDER_MODEL_DEFAULTS: Record<ProviderId, ProviderModelDefault> = {
  claude: {
    label: "Claude Haiku 4.5",
    modelId: "claude-haiku-4-5",
    launchMode: "structured-json"
  },
  codex: {
    label: "Codex Spark",
    modelId: "gpt-5.3-codex-spark",
    reasoningEffort: "medium",
    launchMode: "structured-json"
  },
  cursor: {
    label: "Cursor Composer 2",
    modelId: "composer-2",
    launchMode: "structured-json"
  }
};

// ---------------------------------------------------------------------------
// Pricing — USD per 1M tokens. Sourced from each provider's public pricing
// page; last verified 2026-04.
// ---------------------------------------------------------------------------

export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-7":     { input: 5,    output: 25,  cacheRead: 0.5,   cacheWrite: 6.25 },
  "claude-opus-4-6":     { input: 5,    output: 25,  cacheRead: 0.5,   cacheWrite: 6.25 },
  "claude-opus-4-5":     { input: 5,    output: 25,  cacheRead: 0.5,   cacheWrite: 6.25 },
  "claude-opus-4-1":     { input: 15,   output: 75,  cacheRead: 1.5,   cacheWrite: 18.75 },
  "claude-opus-4":       { input: 15,   output: 75,  cacheRead: 1.5,   cacheWrite: 18.75 },
  "claude-sonnet-4-6":   { input: 3,    output: 15,  cacheRead: 0.3,   cacheWrite: 3.75 },
  "claude-sonnet-4-5":   { input: 3,    output: 15,  cacheRead: 0.3,   cacheWrite: 3.75 },
  "claude-sonnet-4":     { input: 3,    output: 15,  cacheRead: 0.3,   cacheWrite: 3.75 },
  "claude-3-7-sonnet":   { input: 3,    output: 15,  cacheRead: 0.3,   cacheWrite: 3.75 },
  "claude-haiku-4-5":    { input: 1,    output: 5,   cacheRead: 0.1,   cacheWrite: 1.25 },
  "claude-3-5-haiku":    { input: 0.8,  output: 4,   cacheRead: 0.08,  cacheWrite: 1 },
  "claude-3-opus":       { input: 15,   output: 75,  cacheRead: 1.5,   cacheWrite: 18.75 },
  "claude-3-haiku":      { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.3 },

  "gpt-5":               { input: 1.25, output: 10,  cacheRead: 0.125, cacheWrite: 0 },
  "gpt-5-codex":         { input: 1.25, output: 10,  cacheRead: 0.125, cacheWrite: 0 },
  "gpt-5-codex-mini":    { input: 0.25, output: 2,   cacheRead: 0.025, cacheWrite: 0 },
  "gpt-5.1":             { input: 1.75, output: 14,  cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.1-codex-max":   { input: 1.75, output: 14,  cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.1-codex-mini":  { input: 0.25, output: 2,   cacheRead: 0.025, cacheWrite: 0 },
  "gpt-5.2":             { input: 1.75, output: 14,  cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.2-codex":       { input: 1.75, output: 14,  cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.3":             { input: 1.75, output: 14,  cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.3-codex":       { input: 1.75, output: 14,  cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.3-codex-spark": { input: 1.75, output: 14,  cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.3-chat-latest": { input: 1.75, output: 14,  cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.4":             { input: 2.5,  output: 15,  cacheRead: 0.25,  cacheWrite: 0 },
  "gpt-5.4-codex":       { input: 2.5,  output: 15,  cacheRead: 0.25,  cacheWrite: 0 },
  "gpt-5.4-mini":        { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
  "gpt-5.4-nano":        { input: 0.2,  output: 1.25, cacheRead: 0.02, cacheWrite: 0 },
  "gpt-5.4-pro":         { input: 30,   output: 180, cacheRead: 0,     cacheWrite: 0 },
  "gpt-5.5":             { input: 5,    output: 30,  cacheRead: 0.5,   cacheWrite: 0 },
  "gpt-5.5-pro":         { input: 30,   output: 180, cacheRead: 0,     cacheWrite: 0 },
  "o4-mini":             { input: 1.1,  output: 4.4, cacheRead: 0.275, cacheWrite: 0 },

  // Cursor's bundled models are subscription-billed via Cursor's plan, not
  // per-token through the underlying API. All Cursor-routed ids report $0 so
  // cost telemetry doesn't claim charges that aren't incurred at the API
  // layer. (audit-2026-05-17 H2 — the `-medium` aliased ids previously
  // mirrored base pricing, contradicting this rule.)
  "composer-2":              { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "claude-opus-4-7-medium":  { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "gpt-5.5-medium":          { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
};

export interface UsageCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Strips a trailing `-YYYYMMDD` date suffix from a model id. */
export function normalizeModelId(modelId: string): string {
  return modelId.replace(/-\d{8}$/, "");
}

// Bounded so a runaway caller passing dynamic ids can't leak this dedup set.
const loggedUnknownModels = new BoundedSet<string>(100);

/**
 * Returns USD cost for the given usage. Unknown model ids resolve to 0 and
 * log once via logger.warn — never throw, never block streaming.
 */
export function costOf(usage: UsageCounts, modelId: string): number {
  const key = normalizeModelId(modelId);
  const price = MODEL_PRICING[key];
  if (!price) {
    if (loggedUnknownModels.add(key)) {
      logger.warn("pricing", "unknown model id", { modelId, normalized: key });
    }
    return 0;
  }
  const M = 1_000_000;
  return (
    (usage.input * price.input) / M +
    (usage.output * price.output) / M +
    (usage.cacheRead * price.cacheRead) / M +
    (usage.cacheWrite * price.cacheWrite) / M
  );
}

/** Test-only hook to reset the unknown-model log dedupe. */
export function __resetUnknownModelLog(): void {
  loggedUnknownModels.clear();
}
