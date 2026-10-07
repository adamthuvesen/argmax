import { BoundedSet } from "./boundedSet.js";
import type {
  ReasoningEffort as BindingReasoningEffort,
  UsageCounts as BindingUsageCounts
} from "./bindings.js";
import { logger } from "./logger.js";
import type { ProviderId } from "./types.js";

export type ReasoningEffort = BindingReasoningEffort;

/** One model in a provider's catalog: display label, CLI id, and capabilities
 *  (effort support, context window, badges). */
interface ProviderModelOption {
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
  /** Fast mode verified for this model through Argmax's active chat transport. */
  supportsFastMode?: boolean;
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
interface ProviderModelDefault extends ProviderModelOption {
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
 * models run the full low→ultra list. Codex Astra/Sol/Terra match that (their CLI
 * catalog lists max and ultra). Codex Luna stops at Max. Cursor's GPT-5.6
 * Luna/Terra/Sol, Opus 5 Thinking, Opus 5.5, and Sonnet 5.5 go to Max (no Ultra suffix).
 * Cursor Grok 4.7 goes to Extra High; Cursor Grok 4.6/4.5 and Gemini 3.8 Flash
 * stop at High. OpenCode's OpenRouter models ship non-prefix variant lists
 * because their CLI exposes only certain discrete levels (e.g. low/high/max).
 * Kept in sync with the Rust adapters' effort → model mapping.
 */
export function reasoningEffortsForModel(provider: ProviderId, modelId: string): readonly ReasoningEffort[] {
  if (provider === "claude") return REASONING_EFFORTS; // low → ultra
  if (provider === "codex") {
    if (
      modelId === "gpt-6-astra" ||
      modelId === "gpt-6.1-sol" ||
      modelId === "gpt-6-sol" ||
      modelId === "gpt-5.6-sol" ||
      modelId === "gpt-5.6-terra"
    ) {
      return REASONING_EFFORTS; // low → ultra
    }
    if (modelId === "gpt-6-luna" || modelId === "gpt-5.6-luna") return REASONING_EFFORTS.slice(0, 5); // low → max
    return REASONING_EFFORTS.slice(0, 4); // unknown/legacy: low → xhigh
  }
  if (
    provider === "cursor" &&
    (modelId.startsWith("claude-opus-5-thinking") ||
      modelId.startsWith("claude-opus-5-5") ||
      modelId.startsWith("claude-sonnet-5-5") ||
      modelId.startsWith("gpt-5.6-luna") ||
      modelId.startsWith("gpt-5.6-terra") ||
      modelId.startsWith("gpt-5.6-sol"))
  ) {
    return REASONING_EFFORTS.slice(0, 5); // low → max
  }
  if (provider === "cursor" && modelId.startsWith("grok-4.7")) {
    return REASONING_EFFORTS.slice(0, 4); // low → xhigh
  }
  if (
    provider === "cursor" &&
    (modelId.startsWith("cursor-grok-4.6") ||
      modelId.startsWith("cursor-grok-4.5") ||
      modelId.startsWith("gemini-3.8-flash"))
  ) {
    return REASONING_EFFORTS.slice(0, 3); // low → high
  }
  // OpenCode models that expose `--variant`, each with its own set; fall back
  // to low → xhigh for the rest (which won't set supportsReasoningEffort).
  // Qwen3.8 Max and Muse Spark also offer a `minimal` variant below Low, which
  // has no rung on this ladder and is left out.
  const opencodeVariants: Record<string, readonly ReasoningEffort[]> = {
    "openrouter/z-ai/glm-5.3-flash": ["low", "high", "max"],
    "openrouter/z-ai/glm-5.3": ["low", "high", "max"],
    "openrouter/deepseek/deepseek-v4.1-flash": ["low", "high", "max"],
    "openrouter/deepseek/deepseek-v4-pro-0813": ["low", "high", "max"],
    "openrouter/moonshotai/kimi-k3": ["low", "high", "max"],
    "openrouter/qwen/qwen3.8-max-0902": ["low", "medium", "high", "xhigh"],
    "openrouter/qwen/qwen3.8-flash": ["high", "max"],
    "openrouter/meta/muse-spark-1.3-contributor": ["low", "medium", "high", "xhigh", "max"]
  };
  if (provider === "opencode" && modelId in opencodeVariants) return opencodeVariants[modelId];
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

/**
 * Effort a model actually runs at, given the app-wide default effort the user
 * picked in Settings. Models offer different ladders (Grok Build stops at
 * Extra High, the OpenCode variants are discrete sets), so a single global
 * preference cannot apply verbatim everywhere:
 *
 *  - the preferred level when the model offers it;
 *  - otherwise Medium, the level almost every ladder carries;
 *  - otherwise the nearest level at or below Medium, and failing that the
 *    model's lowest.
 *
 * Callers gate on `supportsReasoningEffort` — a fast model has no effort at
 * all, and this function does not look at that flag.
 */
export function effortForModel(
  provider: ProviderId,
  modelId: string,
  preferred: ReasoningEffort = DEFAULT_REASONING_EFFORT
): ReasoningEffort | undefined {
  const allowed = reasoningEffortsForModel(provider, modelId);
  if (allowed.includes(preferred)) return preferred;
  return clampEffort(DEFAULT_REASONING_EFFORT, allowed);
}

// One entry per model. Effort is chosen separately via the effort control (the
// standalone slider chip, or the per-row Edit submenu), not by selecting a
// different row. Models without `supportsReasoningEffort` are fast/no-effort and
// hide the effort control.
//
// NOTE: Cursor's `modelId`s keep their `-medium` alias as a stable base. Effort
// and Fast ride in `reasoningEffort` / fast mode: chats set them as ACP config
// options (cursor_acp.rs), the one-shot CLI folds them into the `--model`
// variant (adapters.rs). Keep the picker's id stable.
export const PROVIDER_MODELS: Record<ProviderId, ProviderModelOption[]> = {
  // Claude Code offers Fast on Opus 5.5 (and Opus 5 / 4.8, outside this
  // catalog), at twice the price. Do not enable it for other models: turning it
  // on switches the chat to Opus. https://code.claude.com/docs/en/fast-mode
  claude: [
    { label: "Fable 5.1", modelId: "claude-fable-5-1", supportsReasoningEffort: true, contextWindow: 1_000_000 },
    { label: "Opus 5.5", modelId: "claude-opus-5-5", supportsReasoningEffort: true, supportsFastMode: true, contextWindow: 1_000_000 },
    { label: "Sonnet 5.5", modelId: "claude-sonnet-5-5", supportsReasoningEffort: true, contextWindow: 1_000_000 },
    { label: "Haiku 5.5", modelId: "claude-haiku-5-5", contextWindow: 1_000_000 }
  ],
  // The GPT-6 models' Codex CLI catalog reports a 272_000 default context. Live
  // rollouts can replace it with the model_context_window value they report.
  // 258_400, not the 272_000 the model card advertises: that is the figure
  // Codex itself reports as `model_context_window` in its rollout, and the one
  // the CLI measures occupancy against. Verified against codex-cli 0.149.0.
  codex: [
    { label: "GPT-6 Astra", modelId: "gpt-6-astra", supportsReasoningEffort: true, supportsFastMode: true, contextWindow: 272_000 },
    { label: "GPT-6.1 Sol", modelId: "gpt-6.1-sol", supportsReasoningEffort: true, supportsFastMode: true, contextWindow: 272_000 },
    { label: "GPT-5.6 Terra", modelId: "gpt-5.6-terra", supportsReasoningEffort: true, supportsFastMode: true, contextWindow: 258_400 },
    { label: "GPT-6 Luna", modelId: "gpt-6-luna", supportsReasoningEffort: true, supportsFastMode: true, contextWindow: 272_000 }
  ],
  cursor: [
    { label: "Auto Cost (Cursor)", modelId: "auto-smart[optimize_for=cost]" },
    { label: "Auto Balance (Cursor)", modelId: "auto-smart[optimize_for=balanced]" },
    { label: "Auto Intelligence (Cursor)", modelId: "auto-smart[optimize_for=intelligence]" },
    // Composer always runs Fast (cursor_fast_mode in adapters.rs), so it shows no Fast toggle.
    { label: "Composer 2.5 (Cursor)", modelId: "composer-2.5", contextWindow: 1_000_000 },
    {
      label: "Grok 4.7 (Cursor)",
      modelId: "grok-4.7-medium",
      supportsReasoningEffort: true,
      supportsFastMode: true,
      contextWindow: 1_000_000
    },
    {
      label: "Gemini 3.8 Flash (Cursor)",
      modelId: "gemini-3.8-flash-medium",
      supportsReasoningEffort: true,
      contextWindow: 1_000_000
    },
    { label: "GPT-5.6 Sol (Cursor)", modelId: "gpt-5.6-sol-medium", supportsReasoningEffort: true, supportsFastMode: true, contextWindow: 1_000_000 },
    { label: "GPT-5.6 Terra (Cursor)", modelId: "gpt-5.6-terra-medium", supportsReasoningEffort: true, supportsFastMode: true, contextWindow: 1_000_000 },
    { label: "GPT-5.6 Luna (Cursor)", modelId: "gpt-5.6-luna-medium", supportsReasoningEffort: true, supportsFastMode: true, contextWindow: 1_000_000 },
    {
      label: "Claude Opus 5.5 (Cursor)",
      modelId: "claude-opus-5-5-medium",
      supportsReasoningEffort: true,
      supportsFastMode: true,
      contextWindow: 1_000_000
    },
    // cursor-agent 2026.09.26 lists low through max and no `-fast` ids.
    {
      label: "Claude Sonnet 5.5 (Cursor)",
      modelId: "claude-sonnet-5-5-medium",
      supportsReasoningEffort: true,
      contextWindow: 1_000_000
    }
  ],
  // OpenCode runs every model through OpenRouter, on the OpenRouter key in
  // OpenCode's own auth (`opencode auth login`). Ids keep the
  // `openrouter/<vendor>/<model>` form the CLI's `-m` flag expects. Effort
  // variants ride the CLI's `--variant` flag; keep the variant map in
  // reasoningEffortsForModel and the Rust adapter in sync with these. No
  // fast-mode control: MiniMax M2.7 is the fast model, pinned to Groq in the
  // OpenCode server's inline config (openrouter_host_pins in opencode_server.rs).
  //
  // Muse Spark 1.3 Contributor is cheap because Meta trains on the prompts and
  // completions it sees, which is what "contributor" in its id means.
  opencode: [
    { label: "GLM-5.3-Flash", modelId: "openrouter/z-ai/glm-5.3-flash", supportsReasoningEffort: true, contextWindow: 1_048_576 },
    { label: "GLM-5.3", modelId: "openrouter/z-ai/glm-5.3", supportsReasoningEffort: true, contextWindow: 1_048_576 },
    {
      label: "DeepSeek V4.1 Flash",
      modelId: "openrouter/deepseek/deepseek-v4.1-flash",
      supportsReasoningEffort: true,
      contextWindow: 1_048_576
    },
    {
      label: "DeepSeek V4 Pro",
      modelId: "openrouter/deepseek/deepseek-v4-pro-0813",
      supportsReasoningEffort: true,
      contextWindow: 1_048_576
    },
    { label: "Kimi K3", modelId: "openrouter/moonshotai/kimi-k3", supportsReasoningEffort: true, contextWindow: 1_048_576 },
    { label: "Qwen3.8 Max", modelId: "openrouter/qwen/qwen3.8-max-0902", supportsReasoningEffort: true, contextWindow: 1_000_000 },
    { label: "Qwen3.8 Flash", modelId: "openrouter/qwen/qwen3.8-flash", supportsReasoningEffort: true, contextWindow: 1_000_000 },
    {
      label: "Muse Spark 1.3 Contributor",
      modelId: "openrouter/meta/muse-spark-1.3-contributor",
      supportsReasoningEffort: true,
      contextWindow: 1_048_576
    },
    // Groq's window, not the model's 204,800: the pin keeps it on Groq.
    { label: "MiniMax M2.7 (Groq)", modelId: "openrouter/minimax/minimax-m2.7", contextWindow: 196_608 }
  ],
  // The picker offers Grok 4.7. It takes --reasoning-effort up to xhigh (the
  // CLI rejects max/ultra). Fast is the advertised SKU `grok-4.7-build-fast`.
  // 500K window per xAI's published model card. 4.6 and 4.5 stay priced for
  // sessions already launched on them.
  grok: [
    { label: "Grok 4.7", modelId: "grok-4.7", supportsReasoningEffort: true, supportsFastMode: true, contextWindow: 500_000 }
  ]
};

// Cheap, fast model per provider used only to mint a short sidebar title from
// the launch prompt (see workspaces:autotitle). A title is a handful of tokens,
// so this path stays ~free and should snap in within a second or two instead of
// blocking on the session's (possibly Opus-high) model. Claude uses Sonnet at
// `--effort low` rather than Haiku: a local bake-off found it roughly twice as
// fast for this prompt, with matching title quality.
export const PROVIDER_TITLE_MODEL: Record<ProviderId, string> = {
  claude: "claude-sonnet-5-5",
  codex: "gpt-6-luna",
  cursor: "composer-2.5",
  opencode: "openrouter/z-ai/glm-5.3-flash",
  // Same Grok Build rate as the chat model.
  grok: "grok-4.7"
};

/**
 * Providers a chat can be forked from, which is what the turn footer's Fork
 * button rides. Every provider forks: Claude, Codex, OpenCode and Grok may
 * continue the source conversation natively where that is exact, and Cursor —
 * which cannot resume one conversation from two sessions — always starts the
 * fork fresh from the copied visible history. See docs/providers.md
 * (Native continuity and forks).
 */
export const FORK_CAPABLE_PROVIDERS: ReadonlySet<string> = new Set<ProviderId>([
  "claude",
  "codex",
  "cursor",
  "opencode",
  "grok"
]);

export const PROVIDER_MODEL_DEFAULTS: Record<ProviderId, ProviderModelDefault> = {
  claude: {
    label: "Opus 5.5",
    modelId: "claude-opus-5-5",
    supportsReasoningEffort: true
  },
  codex: {
    label: "GPT-6.1 Sol",
    modelId: "gpt-6.1-sol",
    supportsReasoningEffort: true
  },
  cursor: {
    label: "Grok 4.7 (Cursor)",
    modelId: "grok-4.7-medium",
    supportsReasoningEffort: true
  },
  // GLM-5.3-Flash's variant list is low/high/max (no medium), so seed High
  // rather than DEFAULT_REASONING_EFFORT.
  opencode: {
    label: "GLM-5.3-Flash",
    modelId: "openrouter/z-ai/glm-5.3-flash",
    supportsReasoningEffort: true,
    reasoningEffort: "high"
  },
  grok: {
    label: "Grok 4.7",
    modelId: "grok-4.7",
    supportsReasoningEffort: true
  }
};

// ---------------------------------------------------------------------------
// Pricing — USD per 1M tokens. Keep this table in sync with the Rust pricing
// mirror and the providers' published pricing.
// ---------------------------------------------------------------------------

interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Fable 5.1 keeps Fable 5's per-token rates but cache reads drop to
  // $0.25/MTok (0.025x), a quarter of Fable 5's.
  "claude-fable-5-1":    { input: 10,   output: 50,  cacheRead: 0.25,  cacheWrite: 12.5 },
  // Claude Code 2.1.280 catalog tier `tier_4_20_cache_read_0_20`.
  "claude-opus-5-5":     { input: 4,    output: 20,  cacheRead: 0.2,   cacheWrite: 5 },
  "claude-opus-5":       { input: 5,    output: 25,  cacheRead: 0.5,   cacheWrite: 6.25 },
  "claude-sonnet-5-5":   { input: 2,    output: 10,  cacheRead: 0.2,   cacheWrite: 2.5 },
  // Short-prompt rates (up to 100K). Above 100K Haiku 5.5 bills $0.50 / $2.50; that surcharge is not modeled.
  "claude-haiku-5-5":    { input: 0.1,  output: 0.5, cacheRead: 0.01,  cacheWrite: 0.125 },
  "claude-haiku-4-5":    { input: 1,    output: 5,   cacheRead: 0.1,   cacheWrite: 1.25 },

  // Short-context rates (<272K). Long-context multipliers are not modeled.
  "gpt-6-astra":         { input: 10,   output: 50,  cacheRead: 1,    cacheWrite: 12.5 },
  "gpt-6.1-sol":         { input: 2,    output: 10,  cacheRead: 0.2,   cacheWrite: 2.5 },
  "gpt-6-sol":           { input: 2,    output: 10,  cacheRead: 0.2,   cacheWrite: 2.5 },
  "gpt-6-luna":          { input: 0.1,  output: 0.5, cacheRead: 0.01,  cacheWrite: 0.125 },
  // Promotional rate, promised through at least 2026-11-21.
  "gpt-5.6-sol":         { input: 4,    output: 20,  cacheRead: 0.4,   cacheWrite: 5 },
  "gpt-5.6-terra":       { input: 2,    output: 12,  cacheRead: 0.2,   cacheWrite: 2.5 },
  "gpt-5.6-luna":        { input: 0.2,  output: 1.2, cacheRead: 0.02,  cacheWrite: 0.25 },

  // Cursor billing is not estimated here. Zero is the existing telemetry
  // placeholder, not a claim that Cursor usage is free. Auto's routed model
  // can change per request, so it has no fixed token rate.
  "auto-smart[optimize_for=cost]":         { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "auto-smart[optimize_for=balanced]":     { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "auto-smart[optimize_for=intelligence]": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "composer-2.5":                     { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "grok-4.7-medium":                  { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "cursor-grok-4.6-medium":           { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "gemini-3.8-flash-medium":          { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "gpt-5.6-sol-medium":               { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "gpt-5.6-terra-medium":             { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "gpt-5.6-luna-medium":              { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "claude-opus-5-5-medium":           { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "claude-sonnet-5-5-medium":         { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "claude-opus-5-thinking-medium":    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },

  // OpenCode via OpenRouter. OpenRouter spreads a request across hosts whose
  // rates differ several-fold, and OpenCode's own `cost` is the catalog's
  // cheapest rate per field, which no host charges (about 20x low on a test
  // turn, 2026-10-04). So these are the model maker's own host rates on
  // OpenRouter (Groq's for the pinned MiniMax): an estimate, not the bill.
  // Cache writes bill as plain input. Keep in sync with the Rust pricing mirror.
  "openrouter/z-ai/glm-5.3-flash":              { input: 0.15,  output: 0.5,    cacheRead: 0.03,  cacheWrite: 0.15 },
  "openrouter/z-ai/glm-5.3":                    { input: 1.4,   output: 4.4,    cacheRead: 0.26,  cacheWrite: 1.4 },
  "openrouter/deepseek/deepseek-v4.1-flash":    { input: 0.15,  output: 0.6,    cacheRead: 0.003, cacheWrite: 0.15 },
  "openrouter/deepseek/deepseek-v4-pro-0813":   { input: 0.66,  output: 1.98,   cacheRead: 0.022, cacheWrite: 0.66 },
  "openrouter/moonshotai/kimi-k3":              { input: 3,     output: 15,     cacheRead: 0.3,   cacheWrite: 3 },
  "openrouter/qwen/qwen3.8-max-0902":           { input: 2,     output: 6,      cacheRead: 0.25,  cacheWrite: 2.5 },
  "openrouter/qwen/qwen3.8-flash":              { input: 0.15,  output: 0.47,   cacheRead: 0.016, cacheWrite: 0.2 },
  "openrouter/meta/muse-spark-1.3-contributor": { input: 0.1,   output: 0.2,    cacheRead: 0.002, cacheWrite: 0.1 },
  // Groq offers no cached-input discount for this model.
  "openrouter/minimax/minimax-m2.7":            { input: 0.6,   output: 1.8,    cacheRead: 0.6,   cacheWrite: 0.6 },

  // Grok Build bills its own SKUs (`grok-4.7-build` / `grok-4.6-build` /
  // `grok-4.5-build` in the CLI's modelUsage map), not xAI's public API list
  // price (4.7 lists at $2 / $6; its SKU is 0.34x that). Every rate was solved
  // from the `costUsdTicks` Grok reported on 2026-09-27 (grok 1.0.41) and
  // reproduces it to the tick. 4.7 and 4.6 share a rate, doubled since
  // 2026-09-01; 4.5 matches them except on cache reads; 4.7 Fast is twice 4.7.
  // Cache writes are never billed separately. Keep in sync with the Rust
  // pricing mirror.
  "grok-4.7":                              { input: 0.68,  output: 2.04,   cacheRead: 0.17,  cacheWrite: 0 },
  "grok-4.7-build-fast":                   { input: 1.36,  output: 4.08,   cacheRead: 0.34,  cacheWrite: 0 },
  "grok-4.6":                              { input: 0.68,  output: 2.04,   cacheRead: 0.17,  cacheWrite: 0 },
  "grok-4.5":                              { input: 0.68,  output: 2.04,   cacheRead: 0.102, cacheWrite: 0 }
};

const STORED_MODEL_PRICING_ALIASES: Record<string, ModelPricing> = {
  "claude-fable-5":       { input: 10,   output: 50,   cacheRead: 1,     cacheWrite: 12.5 },
  "claude-sonnet-5":      { input: 2,    output: 10,   cacheRead: 0.2,   cacheWrite: 2.5 },
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
  "gemini-3.7-flash-medium": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "cursor-grok-4.5-medium": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
};

export type UsageCounts = BindingUsageCounts;

/** Strips a trailing `-YYYYMMDD` date suffix from a model id. */
export function normalizeModelId(modelId: string): string {
  return modelId.replace(/-\d{8}$/, "");
}

/**
 * Retired ids and the catalog id that replaced each. A stored Sonnet 5
 * session, routine, or launch preference follows Sonnet 5.5 instead of
 * falling through to the provider default. The stored row is left alone;
 * only the pick the user sees and the model the CLI runs move. Mirrored by
 * `claude_model_arg` (adapters.rs) and shipped to the phone in
 * providerModels.json.
 */
export const SUCCESSOR_MODEL_IDS: Partial<Record<ProviderId, Readonly<Record<string, string>>>> = {
  claude: { "claude-sonnet-5": "claude-sonnet-5-5", "claude-haiku-4-5": "claude-haiku-5-5" },
  codex: { "gpt-6-sol": "gpt-6.1-sol" }
};

/** Catalog id that replaced a stored one, or the id itself. */
export function successorModelId(provider: ProviderId, modelId: string): string {
  return SUCCESSOR_MODEL_IDS[provider]?.[normalizeModelId(modelId)] ?? modelId;
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
  const wanted = normalizeModelId(successorModelId(provider, modelId));
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
/** List price for a known model, or null when the catalog has no rate.
 *  A known free model is `0`, which is a price. Unknown is not. */
export function listedCost(usage: UsageCounts, modelId: string): number | null {
  const key = normalizeModelId(modelId);
  const price = MODEL_PRICING[key] ?? STORED_MODEL_PRICING_ALIASES[key];
  if (!price) return null;
  const million = 1_000_000;
  return (
    (usage.input * price.input) / million +
    (usage.output * price.output) / million +
    (usage.cacheRead * price.cacheRead) / million +
    (usage.cacheWrite * price.cacheWrite) / million
  );
}

export function costOf(usage: UsageCounts, modelId: string): number {
  const cost = listedCost(usage, modelId);
  if (cost === null) {
    const key = normalizeModelId(modelId);
    if (loggedUnknownModels.add(key)) {
      logger.warn("pricing", "unknown model id", { modelId, normalized: key });
    }
    return 0;
  }
  return cost;
}

/** Test-only hook to reset the unknown-model log dedupe. */
export function __resetUnknownModelLog(): void {
  loggedUnknownModels.clear();
}

/**
 * The model's context-window size in tokens from its definition, or null when
 * unknown. Codex can replace this with a live `model_context_window` on the
 * session row; other providers never write that column, so they always fall
 * back here — including after a switch away from Codex that left a stale
 * window behind.
 */
export function contextWindowForModel(modelId: string): number | null {
  for (const [provider, models] of Object.entries(PROVIDER_MODELS) as [ProviderId, ProviderModelOption[]][]) {
    // A retired id reads its successor's window, the model it now launches on.
    const id = normalizeModelId(successorModelId(provider, modelId));
    const match = models.find((model) => model.modelId === id);
    if (match?.contextWindow) return match.contextWindow;
  }
  return null;
}
