import { BoundedSet } from "./boundedSet.js";
import type { ReasoningEffort as BindingReasoningEffort } from "./bindings.js";
import { logger } from "./logger.js";
import type { ProviderId } from "./types.js";

export type ReasoningEffort = BindingReasoningEffort;

/** One model in a provider's catalog: display label, CLI id, and capabilities
 *  (effort support, context window, badges). */
export interface ProviderModelOption {
  label: string;
  modelId: string;
  /**
   * When true, the model exposes an editable reasoning effort. The levels
   * offered are model-specific (see reasoningEffortsForModel). Omit for
   * fast / non-reasoning models (Haiku, Cursor Composer 2.5) which render
   * without an effort control. This is the model's capability. Whether a
   * given picker surface renders the standalone slider is the separate
   * `withEffortSlider` prop on the ModelSelector.
   */
  supportsReasoningEffort?: boolean;
  /**
   * Context-window size in tokens. Used to show window occupancy when the
   * provider doesn't report it on the session — in practice that is every
   * provider, including Codex, whose window rides only on the `token_count`
   * rows `codex exec --json` no longer emits. Approximate — revisit when a
   * provider changes its window.
   */
  contextWindow?: number;
  description?: string;
  badge?: string;
}

/** A {@link ProviderModelOption} plus a seeded effort. Used for each
 * provider's default model. */
export interface ProviderModelDefault extends ProviderModelOption {
  reasoningEffort?: ReasoningEffort;
}

/** A model the user has chosen — only what's needed to launch and display it,
 *  without the catalog metadata of {@link ProviderModelOption}. */
export interface ProviderModelSelection {
  label: string;
  modelId: string;
  reasoningEffort?: ReasoningEffort;
}

/** Provider names as written in the UI. The Rust side keeps its own copy in
 *  `get_provider_definition`; keep the two spellings in step. */
export const PROVIDER_DISPLAY_NAMES: Record<ProviderId, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  grok: "Grok Build"
};

/** All effort levels, low → high. Each model's picker list is a prefix or
 *  discrete subset. Adapters clamp any level that slips through (provider
 *  switch, resume, session-control) down to that model's ceiling. */
export const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;

/**
 * Effort levels a given model offers in the picker, low → high. Claude's own
 * models run the full low→ultra list. Codex Sol/Terra match that (their CLI
 * catalog lists max and ultra). Codex Luna stops at Max. Cursor's GPT-5.6
 * Luna/Terra/Sol and Opus 5 Thinking go to Max (no Ultra suffix). Cursor Grok
 * 4.6 and Gemini 3.7 Flash stop at High. OpenCode Go (opencode-go/*) models
 * ship non-prefix variant lists because their CLI exposes only certain
 * discrete levels (e.g. low/high/max). Kept in sync with the Rust adapters'
 * effort → model mapping.
 */
export function reasoningEffortsForModel(provider: ProviderId, modelId: string): readonly ReasoningEffort[] {
  if (provider === "claude") return REASONING_EFFORTS; // low → ultra
  if (provider === "codex") {
    if (modelId === "gpt-5.6-sol" || modelId === "gpt-5.6-terra") return REASONING_EFFORTS; // low → ultra
    if (modelId === "gpt-5.6-luna") return REASONING_EFFORTS.slice(0, 5); // low → max
    return REASONING_EFFORTS.slice(0, 4); // unknown/legacy: low → xhigh
  }
  if (
    provider === "cursor" &&
    (modelId.startsWith("claude-opus-5-thinking") ||
      modelId.startsWith("gpt-5.6-luna") ||
      modelId.startsWith("gpt-5.6-terra") ||
      modelId.startsWith("gpt-5.6-sol"))
  ) {
    return REASONING_EFFORTS.slice(0, 5); // low → max
  }
  if (
    provider === "cursor" &&
    (modelId.startsWith("cursor-grok-4.6") ||
      modelId.startsWith("cursor-grok-4.5") ||
      modelId.startsWith("gemini-3.7-flash"))
  ) {
    return REASONING_EFFORTS.slice(0, 3); // low → high
  }
  // OpenCode Go models have discrete variant sets; fall back to low → xhigh
  // for non-variant opencode models (which won't set supportsReasoningEffort).
  const opencodeGoVariants: Record<string, readonly ReasoningEffort[]> = {
    "opencode-go/glm-5.3-flash": ["low", "high", "max"],
    "opencode-go/glm-5.3": ["low", "high", "max"],
    "opencode-go/kimi-k3": ["max"],
    "opencode-go/qwen3.8-flash": ["high", "max"],
    "opencode-go/deepseek-v4-pro": ["high", "max"],
    "opencode-go/deepseek-v4-flash": ["low", "high", "max"]
  };
  if (provider === "opencode" && modelId in opencodeGoVariants) return opencodeGoVariants[modelId];
  // Grok Build's --reasoning-effort accepts only low/medium/high/xhigh; the CLI
  // rejects anything above with "unknown effort level". Mirrors grok_reasoning_args.
  if (provider === "grok") return ["low", "medium", "high", "xhigh"];
  return REASONING_EFFORTS.slice(0, 4); // low → xhigh
}

/**
 * Carry an effort onto a target model's supported levels when switching model
 * or provider. Keeps it if the target supports it; otherwise clamps DOWN to
 * the highest supported effort at or below the incoming effort in the global
 * low→ultra order (so a "medium" incoming effort mapping to ["low","high","max"]
 * returns "low", not "high"). Never promotes: a Codex xhigh selection switched
 * to Claude stays xhigh, it does not jump to Ultra. Falls back to the lowest
 * supported effort when no supported level is ≤ the incoming effort.
 * Returns undefined when there's no effort to map. `efforts` must be ordered
 * low→high (a prefix of REASONING_EFFORTS or a discrete subset).
 */
export function clampEffort(
  effort: ReasoningEffort | undefined,
  efforts: readonly ReasoningEffort[]
): ReasoningEffort | undefined {
  if (!effort || efforts.length === 0) return undefined;
  if (efforts.includes(effort)) return effort;
  const incomingRank = REASONING_EFFORTS.indexOf(effort);
  const below = efforts.filter((candidate) => REASONING_EFFORTS.indexOf(candidate) < incomingRank);
  if (below.length > 0) return below[below.length - 1];
  return efforts[0];
}

/** Effort an effort-capable model gets when first picked (before Edit). */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";

// One entry per model. Effort is chosen separately via the effort control (the
// standalone slider chip, or the per-row Edit submenu), not by selecting a
// different row. Models without `supportsReasoningEffort` are fast/no-effort and
// hide the effort control.
//
// NOTE: Cursor's `modelId`s keep their `-medium` alias as a stable base — the
// Cursor CLI selects reasoning effort through the model id (e.g. gpt-5.6-sol-high,
// claude-opus-5-thinking-xhigh), so the Rust cursor adapter folds the chosen
// effort into the launched `--model` variant. Keep the picker's id stable;
// effort rides in `reasoningEffort`.
export const PROVIDER_MODELS: Record<ProviderId, ProviderModelOption[]> = {
  claude: [
    { label: "Fable 5.1", modelId: "claude-fable-5-1", supportsReasoningEffort: true, contextWindow: 1_000_000 },
    { label: "Opus 5", modelId: "claude-opus-5", supportsReasoningEffort: true, contextWindow: 1_000_000 },
    { label: "Sonnet 5", modelId: "claude-sonnet-5", supportsReasoningEffort: true, contextWindow: 200_000 },
    { label: "Haiku 4.5", modelId: "claude-haiku-4-5", contextWindow: 200_000 }
  ],
  // 258_400, not the 272_000 the model card advertises: that is the figure
  // Codex itself reports as `model_context_window` in its rollout, and the one
  // the CLI measures occupancy against. Verified against codex-cli 0.149.0.
  codex: [
    { label: "GPT-5.6 Sol", modelId: "gpt-5.6-sol", supportsReasoningEffort: true, contextWindow: 258_400 },
    { label: "GPT-5.6 Terra", modelId: "gpt-5.6-terra", supportsReasoningEffort: true, contextWindow: 258_400 },
    { label: "GPT-5.6 Luna", modelId: "gpt-5.6-luna", supportsReasoningEffort: true, contextWindow: 258_400 }
  ],
  cursor: [
    { label: "Composer 2.5 (Cursor)", modelId: "composer-2.5", contextWindow: 1_000_000 },
    {
      label: "Grok 4.6 (Cursor)",
      modelId: "cursor-grok-4.6-medium",
      supportsReasoningEffort: true,
      contextWindow: 1_000_000
    },
    {
      label: "Gemini 3.7 Flash (Cursor)",
      modelId: "gemini-3.7-flash-medium",
      supportsReasoningEffort: true,
      contextWindow: 1_000_000
    },
    { label: "GPT-5.6 Sol (Cursor)", modelId: "gpt-5.6-sol-medium", supportsReasoningEffort: true, contextWindow: 1_000_000 },
    { label: "GPT-5.6 Terra (Cursor)", modelId: "gpt-5.6-terra-medium", supportsReasoningEffort: true, contextWindow: 1_000_000 },
    { label: "GPT-5.6 Luna (Cursor)", modelId: "gpt-5.6-luna-medium", supportsReasoningEffort: true, contextWindow: 1_000_000 },
    {
      label: "Claude Opus 5 (Cursor)",
      modelId: "claude-opus-5-thinking-medium",
      supportsReasoningEffort: true,
      contextWindow: 1_000_000
    }
  ],
  // OpenCode Zen free tier. Ids keep the `provider/model` format the OpenCode
  // CLI's `-m` flag expects. None expose a reasoning-effort or fast-mode
  // control (the CLI's `--variant` doesn't apply to the Zen free models).
  //
  // OpenCode Go (opencode-go/*) are billed per-token models with reasoning
  // effort variants wired via the CLI's `--variant` flag. Keep the variant map
  // in reasoningEffortsForModel and the Rust adapter in sync with these.
  opencode: [
    { label: "Big Pickle", modelId: "opencode/big-pickle", contextWindow: 200_000 },
    { label: "Hy3 Free", modelId: "opencode/hy3-free", contextWindow: 190_000 },
    { label: "MiMo V2.5 Free", modelId: "opencode/mimo-v2.5-free", contextWindow: 200_000 },
    { label: "Nemotron 3.5 Lightning Free", modelId: "opencode/nemotron-3.5-lightning-free", contextWindow: 262_144 },
    { label: "Nemotron 3 Ultra Free", modelId: "opencode/nemotron-3-ultra-free", contextWindow: 1_000_000 },
    { label: "GLM-5.3-Flash", modelId: "opencode-go/glm-5.3-flash", supportsReasoningEffort: true, contextWindow: 1_000_000 },
    { label: "GLM-5.3", modelId: "opencode-go/glm-5.3", supportsReasoningEffort: true, contextWindow: 1_000_000 },
    { label: "Kimi K3", modelId: "opencode-go/kimi-k3", supportsReasoningEffort: true, contextWindow: 1_048_576 },
    { label: "Qwen3.8 Max", modelId: "opencode-go/qwen3.8-max", contextWindow: 1_000_000 },
    { label: "Qwen3.8 Flash", modelId: "opencode-go/qwen3.8-flash", supportsReasoningEffort: true, contextWindow: 1_000_000 },
    { label: "DeepSeek V4 Pro", modelId: "opencode-go/deepseek-v4-pro", supportsReasoningEffort: true, contextWindow: 1_000_000 },
    { label: "DeepSeek V4 Flash", modelId: "opencode-go/deepseek-v4-flash", supportsReasoningEffort: true, contextWindow: 1_000_000 }
  ],
  // The two models `grok models` lists. Both take --reasoning-effort up to
  // xhigh (the CLI rejects max/ultra). Grok Build has no fast-mode switch.
  // 500K window per xAI's published model card for both.
  grok: [
    { label: "Grok 4.6", modelId: "grok-4.6", supportsReasoningEffort: true, contextWindow: 500_000 },
    { label: "Grok 4.5", modelId: "grok-4.5", supportsReasoningEffort: true, contextWindow: 500_000 }
  ]
};

// Cheap, fast model per provider used only to mint a short sidebar title from
// the launch prompt (see workspaces:autotitle). A title is a handful of tokens,
// so this path stays ~free and should snap in within a second or two instead of
// blocking on the session's (possibly Opus-high) model. Claude uses Sonnet at
// `--effort low` rather than Haiku: a local bake-off found it roughly twice as
// fast for this prompt, with matching title quality.
export const PROVIDER_TITLE_MODEL: Record<ProviderId, string> = {
  claude: "claude-sonnet-5",
  codex: "gpt-5.6-luna",
  cursor: "composer-2.5",
  opencode: "opencode/big-pickle",
  // 4.5 is the pricier SKU; titles ride the cheaper default model.
  grok: "grok-4.6"
};

/**
 * Providers whose CLI can fork a resumed conversation, which is what the turn
 * footer's Fork button rides: Claude via `--fork-session`, Codex via
 * `exec fork`, OpenCode via `run --fork`. Cursor has no equivalent — resuming
 * its chat id from two sessions would write into one conversation. Mirrors the
 * gate in `fork_session` (src-tauri/src/workspaces/orchestration.rs).
 */
export const FORK_CAPABLE_PROVIDERS: ReadonlySet<string> = new Set<ProviderId>([
  "claude",
  "codex",
  "opencode",
  "grok"
]);

export const PROVIDER_MODEL_DEFAULTS: Record<ProviderId, ProviderModelDefault> = {
  claude: {
    label: "Opus 5",
    modelId: "claude-opus-5",
    supportsReasoningEffort: true
  },
  codex: {
    label: "GPT-5.6 Sol",
    modelId: "gpt-5.6-sol",
    supportsReasoningEffort: true
  },
  cursor: {
    label: "Grok 4.6 (Cursor)",
    modelId: "cursor-grok-4.6-medium",
    supportsReasoningEffort: true
  },
  // GLM-5.3-Flash is an OpenCode Go model. Its variant list is low/high/max
  // (no medium), so seed High rather than DEFAULT_REASONING_EFFORT.
  opencode: {
    label: "GLM-5.3-Flash",
    modelId: "opencode-go/glm-5.3-flash",
    supportsReasoningEffort: true,
    reasoningEffort: "high"
  },
  grok: {
    label: "Grok 4.6",
    modelId: "grok-4.6",
    supportsReasoningEffort: true
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
  // Fable 5.1 keeps Fable 5's per-token rates but cache reads drop to
  // $0.25/MTok (0.025x), a quarter of Fable 5's.
  "claude-fable-5-1":    { input: 10,   output: 50,  cacheRead: 0.25,  cacheWrite: 12.5 },
  "claude-opus-5":       { input: 5,    output: 25,  cacheRead: 0.5,   cacheWrite: 6.25 },
  "claude-sonnet-5":     { input: 3,    output: 15,  cacheRead: 0.3,   cacheWrite: 3.75 },
  "claude-haiku-4-5":    { input: 1,    output: 5,   cacheRead: 0.1,   cacheWrite: 1.25 },

  // Short-context rates (<272K). Long-context multipliers are not modeled.
  "gpt-5.6-sol":         { input: 5,    output: 30,  cacheRead: 0.5,   cacheWrite: 6.25 },
  "gpt-5.6-terra":       { input: 2,    output: 12,  cacheRead: 0.2,   cacheWrite: 2.5 },
  "gpt-5.6-luna":        { input: 0.2,  output: 1.2, cacheRead: 0.02,  cacheWrite: 0.25 },

  // Cursor's bundled models are subscription-billed via Cursor's plan, not
  // per-token through the underlying API. All Cursor-routed ids report $0 so
  // cost telemetry doesn't claim charges that aren't incurred at the API
  // layer.
  "composer-2.5":                     { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "cursor-grok-4.6-medium":           { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "gemini-3.7-flash-medium":          { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "gpt-5.6-sol-medium":               { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "gpt-5.6-terra-medium":             { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "gpt-5.6-luna-medium":              { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "claude-opus-5-thinking-medium":    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },

  // OpenCode Zen free tier — $0 across the board. OpenCode Go (opencode-go/*)
  // is billed per-token. Keep in sync with the Rust pricing mirror.
  "opencode/big-pickle":                   { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "opencode/hy3-free":                     { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "opencode/mimo-v2.5-free":               { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "opencode/nemotron-3.5-lightning-free":  { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "opencode/nemotron-3-ultra-free":        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "opencode-go/glm-5.3-flash":             { input: 0.075, output: 0.25,   cacheRead: 0.015, cacheWrite: 0 },
  "opencode-go/glm-5.3":                   { input: 1.4,   output: 4.4,    cacheRead: 0.26,  cacheWrite: 0 },
  "opencode-go/kimi-k3":                   { input: 3,     output: 15,     cacheRead: 0.3,   cacheWrite: 0 },
  "opencode-go/qwen3.8-max":               { input: 2,     output: 6,      cacheRead: 0.25,  cacheWrite: 2.5 },
  "opencode-go/qwen3.8-flash":             { input: 0.15,  output: 0.47,   cacheRead: 0.016, cacheWrite: 0.2 },
  "opencode-go/deepseek-v4-pro":           { input: 0.66,  output: 1.98,   cacheRead: 0.022, cacheWrite: 0 },
  "opencode-go/deepseek-v4-flash":         { input: 0.22,  output: 0.66,   cacheRead: 0.007, cacheWrite: 0 },

  // Grok Build bills its own SKUs (`grok-4.6-build` / `grok-4.5-build` in the
  // CLI's modelUsage map), not xAI's public API list price. Rates were solved
  // from the CLI's own `total_cost_usd` across runs with varied token mixes and
  // reproduce it exactly. Cache writes are never billed separately. Keep in
  // sync with the Rust pricing mirror.
  "grok-4.6":                              { input: 0.34,  output: 1.02,   cacheRead: 0.085, cacheWrite: 0 },
  "grok-4.5":                              { input: 0.68,  output: 2.04,   cacheRead: 0.102, cacheWrite: 0 }
};

const STORED_MODEL_PRICING_ALIASES: Record<string, ModelPricing> = {
  "claude-fable-5":       { input: 10,   output: 50,   cacheRead: 1,     cacheWrite: 12.5 },
  "claude-opus-4-8":      { input: 5,    output: 25,   cacheRead: 0.5,   cacheWrite: 6.25 },
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
  "gpt-5.5":              { input: 5,    output: 30,   cacheRead: 0.5,   cacheWrite: 0 },
  "gpt-5.5-pro":          { input: 30,   output: 180,  cacheRead: 0,     cacheWrite: 0 },
  "o4-mini":              { input: 1.1,  output: 4.4,  cacheRead: 0.275, cacheWrite: 0 },
  "claude-opus-4-8-medium": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "claude-opus-4-7-medium": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "gpt-5.5-medium":         { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "gemini-3.5-flash":       { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "gemini-3.6-flash-medium": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "cursor-grok-4.5-medium": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
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

/**
 * Display label for a model id, or null when the catalog doesn't know it.
 * Sessions carry a stored label, but it is only as good as whatever wrote it:
 * an imported session's label comes from the provider's transcript, which
 * records the API id ("claude-opus-5"), not a name meant for a chip. The
 * catalog is the authority whenever it recognizes the id.
 */
export function modelLabelFor(provider: ProviderId, modelId: string): string | null {
  if (!modelId) return null;
  const wanted = normalizeModelId(modelId);
  const match = PROVIDER_MODELS[provider]?.find(
    (model) => normalizeModelId(model.modelId) === wanted
  );
  return match?.label ?? null;
}

/**
 * Display label for a model *reference*: a catalog id, or the short alias a
 * provider's own spawn tool takes — Claude's `Agent` launches a subagent with
 * `model: "opus"`, never `claude-opus-5`. An alias resolves only when exactly
 * one of the provider's models carries it as an id segment, so a catalog with
 * two Opus entries reports nothing rather than picking one.
 */
export function modelLabelForReference(provider: ProviderId, reference: string): string | null {
  const direct = modelLabelFor(provider, reference);
  if (direct) return direct;
  const alias = reference.trim().toLowerCase();
  if (!alias) return null;
  const matches = PROVIDER_MODELS[provider]?.filter((model) =>
    normalizeModelId(model.modelId).split("-").includes(alias)
  ) ?? [];
  return matches.length === 1 ? matches[0]?.label ?? null : null;
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
