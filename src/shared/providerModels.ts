import { BoundedSet } from "./boundedSet.js";
import type { ReasoningEffort as BindingReasoningEffort } from "./bindings.js";
import { logger } from "./logger.js";
import type { ProviderId } from "./types.js";

export type ReasoningEffort = BindingReasoningEffort;
export type ProviderLaunchMode = "interactive-pty" | "structured-json";

/** One model in a provider's catalog: display label, CLI id, and capabilities
 *  (effort support, context window, badges). */
export interface ProviderModelOption {
  label: string;
  modelId: string;
  /**
   * When true, the model exposes an editable reasoning effort (Low → Extra
   * High). Omit for fast / non-reasoning models (Haiku, Cursor Composer 2.5)
   * which render without an effort control. This is the model's capability;
   * whether a given picker surface renders the standalone slider is the
   * separate `withEffortSlider` prop on the ModelSelector.
   */
  supportsReasoningEffort?: boolean;
  /**
   * Context-window size in tokens. Used to show window occupancy when the
   * provider doesn't report it on the session (Codex does; Claude/Cursor fall
   * back to this). Approximate — revisit when a provider changes its window.
   */
  contextWindow?: number;
  description?: string;
  badge?: string;
}

/** A {@link ProviderModelOption} plus how to launch it (launch mode and a
 *  seeded effort). Used for each provider's default model. */
export interface ProviderModelDefault extends ProviderModelOption {
  launchMode: ProviderLaunchMode;
  reasoningEffort?: ReasoningEffort;
}

/** A model the user has chosen — only what's needed to launch and display it,
 *  without the catalog metadata of {@link ProviderModelOption}. */
export interface ProviderModelSelection {
  label: string;
  modelId: string;
  reasoningEffort?: ReasoningEffort;
}

/** All effort levels, low → high. Claude exposes the full list; other providers
 *  stop at Extra High — their CLIs don't accept Max/Ultra (the Rust adapters
 *  clamp any that slip through, e.g. after a provider switch). */
export const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;

/**
 * Effort levels a given model offers in the picker, low → high. Claude's own
 * models run the full low→ultra list; Codex and Cursor's GPT-5.5 stop at Extra
 * High; Cursor's Opus 4.8 goes one further to Max (its CLI exposes that variant
 * but not Ultra). Kept in sync with the Rust adapters' effort → model mapping.
 */
export function reasoningEffortsForModel(provider: ProviderId, modelId: string): readonly ReasoningEffort[] {
  if (provider === "claude") return REASONING_EFFORTS; // low → ultra
  if (provider === "cursor" && modelId.startsWith("claude-opus-4-8")) {
    return REASONING_EFFORTS.slice(0, 5); // low → max
  }
  return REASONING_EFFORTS.slice(0, 4); // low → xhigh
}

/**
 * Carry an effort onto a target model's supported levels when switching model
 * or provider. Keeps it if the target supports it (xhigh maps directly — every
 * effort-capable model has it); otherwise clamps DOWN to the highest the target
 * allows. Never promotes: a Codex xhigh selection switched to Claude stays
 * xhigh, it does not jump to Ultra. Returns undefined when there's no effort to
 * map. `efforts` must be a low→high prefix of REASONING_EFFORTS.
 */
export function clampEffort(
  effort: ReasoningEffort | undefined,
  efforts: readonly ReasoningEffort[]
): ReasoningEffort | undefined {
  if (!effort || efforts.length === 0) return undefined;
  if (efforts.includes(effort)) return effort;
  return efforts[efforts.length - 1];
}

/** Effort an effort-capable model gets when first picked (before Edit). */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";

// One entry per model. Effort is chosen separately via the effort control (the
// standalone slider chip, or the per-row Edit submenu), not by selecting a
// different row. Models without `supportsReasoningEffort` are fast/no-effort and
// hide the effort control.
//
// NOTE: Cursor's `modelId`s keep their `-medium` alias as a stable base — the
// Cursor CLI selects reasoning effort through the model id (e.g. gpt-5.5-high,
// claude-opus-4-8-xhigh), so the Rust cursor adapter folds the chosen effort
// into the launched `--model` variant. Keep the picker's id stable; effort
// rides in `reasoningEffort`.
export const PROVIDER_MODELS: Record<ProviderId, ProviderModelOption[]> = {
  claude: [
    { label: "Fable 5", modelId: "claude-fable-5", supportsReasoningEffort: true, contextWindow: 200_000 },
    { label: "Opus 4.8", modelId: "claude-opus-4-8", supportsReasoningEffort: true, contextWindow: 200_000 },
    { label: "Sonnet 5", modelId: "claude-sonnet-5", supportsReasoningEffort: true, contextWindow: 200_000 },
    { label: "Haiku 4.5", modelId: "claude-haiku-4-5", contextWindow: 200_000 }
  ],
  codex: [
    { label: "GPT-5.5", modelId: "gpt-5.5", supportsReasoningEffort: true, contextWindow: 272_000 }
  ],
  cursor: [
    { label: "Composer 2.5 (Cursor)", modelId: "composer-2.5", contextWindow: 1_000_000 },
    { label: "Gemini 3.5 Flash (Cursor)", modelId: "gemini-3.5-flash", contextWindow: 1_000_000 },
    { label: "GPT-5.5 (Cursor)", modelId: "gpt-5.5-medium", supportsReasoningEffort: true, contextWindow: 1_000_000 },
    {
      label: "Claude Opus 4.8 (Cursor)",
      modelId: "claude-opus-4-8-medium",
      supportsReasoningEffort: true,
      contextWindow: 1_000_000
    }
  ]
};

// Cheap, fast model per provider used only to mint a short sidebar title from
// the launch prompt (see workspaces:autotitle). A title is a handful of tokens,
// so picking the smallest model keeps it ~free and lets it snap in within a
// second or two instead of blocking on the session's (possibly Opus-high) model.
export const PROVIDER_TITLE_MODEL: Record<ProviderId, string> = {
  claude: "claude-haiku-4-5",
  codex: "gpt-5.5",
  cursor: "composer-2.5"
};

export const PROVIDER_MODEL_DEFAULTS: Record<ProviderId, ProviderModelDefault> = {
  claude: {
    label: "Opus 4.8",
    modelId: "claude-opus-4-8",
    supportsReasoningEffort: true,
    reasoningEffort: "high",
    launchMode: "structured-json"
  },
  codex: {
    label: "GPT-5.5",
    modelId: "gpt-5.5",
    supportsReasoningEffort: true,
    reasoningEffort: "high",
    launchMode: "structured-json"
  },
  cursor: {
    label: "Composer 2.5 (Cursor)",
    modelId: "composer-2.5",
    launchMode: "structured-json"
  }
};

// ---------------------------------------------------------------------------
// Pricing — USD per 1M tokens. Keep this table in sync with the Rust pricing
// mirror and the providers' published pricing.
// ---------------------------------------------------------------------------

export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-fable-5":      { input: 10,   output: 50,  cacheRead: 1,     cacheWrite: 12.5 },
  "claude-opus-4-8":     { input: 5,    output: 25,  cacheRead: 0.5,   cacheWrite: 6.25 },
  "claude-sonnet-5":     { input: 3,    output: 15,  cacheRead: 0.3,   cacheWrite: 3.75 },
  "claude-haiku-4-5":    { input: 1,    output: 5,   cacheRead: 0.1,   cacheWrite: 1.25 },

  "gpt-5.5":             { input: 5,    output: 30,  cacheRead: 0.5,   cacheWrite: 0 },

  // Cursor's bundled models are subscription-billed via Cursor's plan, not
  // per-token through the underlying API. All Cursor-routed ids report $0 so
  // cost telemetry doesn't claim charges that aren't incurred at the API
  // layer.
  "composer-2.5":            { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "gemini-3.5-flash":        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "claude-opus-4-8-medium":  { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "gpt-5.5-medium":          { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
};

const STORED_MODEL_PRICING_ALIASES: Record<string, ModelPricing> = {
  "claude-opus-4-7":      { input: 5,    output: 25,   cacheRead: 0.5,   cacheWrite: 6.25 },
  "claude-opus-4-6":      { input: 5,    output: 25,   cacheRead: 0.5,   cacheWrite: 6.25 },
  "claude-opus-4-5":      { input: 5,    output: 25,   cacheRead: 0.5,   cacheWrite: 6.25 },
  "claude-opus-4-1":      { input: 15,   output: 75,   cacheRead: 1.5,   cacheWrite: 18.75 },
  "claude-opus-4":        { input: 15,   output: 75,   cacheRead: 1.5,   cacheWrite: 18.75 },
  "claude-sonnet-4-6":    { input: 3,    output: 15,   cacheRead: 0.3,   cacheWrite: 3.75 },
  "claude-sonnet-4-5":    { input: 3,    output: 15,   cacheRead: 0.3,   cacheWrite: 3.75 },
  "claude-sonnet-4":      { input: 3,    output: 15,   cacheRead: 0.3,   cacheWrite: 3.75 },
  "claude-3-7-sonnet":    { input: 3,    output: 15,   cacheRead: 0.3,   cacheWrite: 3.75 },
  "claude-3-5-haiku":     { input: 0.8,  output: 4,    cacheRead: 0.08,  cacheWrite: 1 },
  "claude-3-opus":        { input: 15,   output: 75,   cacheRead: 1.5,   cacheWrite: 18.75 },
  "claude-3-haiku":       { input: 0.25, output: 1.25, cacheRead: 0.03,  cacheWrite: 0.3 },
  "gpt-5":                { input: 1.25, output: 10,   cacheRead: 0.125, cacheWrite: 0 },
  "gpt-5-codex":          { input: 1.25, output: 10,   cacheRead: 0.125, cacheWrite: 0 },
  "gpt-5-codex-mini":     { input: 0.25, output: 2,    cacheRead: 0.025, cacheWrite: 0 },
  "gpt-5.1":              { input: 1.75, output: 14,   cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.1-codex-max":    { input: 1.75, output: 14,   cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.1-codex-mini":   { input: 0.25, output: 2,    cacheRead: 0.025, cacheWrite: 0 },
  "gpt-5.2":              { input: 1.75, output: 14,   cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.2-codex":        { input: 1.75, output: 14,   cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.3":              { input: 1.75, output: 14,   cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.3-codex":        { input: 1.75, output: 14,   cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.3-chat-latest":  { input: 1.75, output: 14,   cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.4":              { input: 2.5,  output: 15,   cacheRead: 0.25,  cacheWrite: 0 },
  "gpt-5.4-codex":        { input: 2.5,  output: 15,   cacheRead: 0.25,  cacheWrite: 0 },
  "gpt-5.4-mini":         { input: 0.75, output: 4.5,  cacheRead: 0.075, cacheWrite: 0 },
  "gpt-5.4-nano":         { input: 0.2,  output: 1.25, cacheRead: 0.02,  cacheWrite: 0 },
  "gpt-5.4-pro":          { input: 30,   output: 180,  cacheRead: 0,     cacheWrite: 0 },
  "gpt-5.5-pro":          { input: 30,   output: 180,  cacheRead: 0,     cacheWrite: 0 },
  "o4-mini":              { input: 1.1,  output: 4.4,  cacheRead: 0.275, cacheWrite: 0 },
  "claude-opus-4-7-medium": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
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
  const price = MODEL_PRICING[key] ?? STORED_MODEL_PRICING_ALIASES[key];
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

/**
 * The model's context-window size in tokens from its definition, or null when
 * unknown. Codex reports its own window on the session row; Claude and Cursor
 * fall back to this.
 */
export function contextWindowForModel(modelId: string): number | null {
  const id = normalizeModelId(modelId);
  for (const models of Object.values(PROVIDER_MODELS)) {
    const match = models.find((model) => model.modelId === id);
    if (match?.contextWindow) return match.contextWindow;
  }
  return null;
}
