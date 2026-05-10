import type { ProviderId } from "./types.js";

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type ProviderLaunchMode = "interactive-pty" | "structured-json";

export interface ProviderModelOption {
  label: string;
  modelId: string;
  reasoningEffort?: ReasoningEffort;
  description?: string;
  badge?: string;
}

export interface ProviderModelDefault extends ProviderModelOption {
  launchMode: ProviderLaunchMode;
}

export type ProviderModelSelection = Pick<ProviderModelOption, "label" | "modelId" | "reasoningEffort">;

export const PROVIDER_MODELS: Record<ProviderId, ProviderModelOption[]> = {
  claude: [
    { label: "Claude Sonnet", modelId: "sonnet", description: "Daily coding default" },
    { label: "Claude Opus", modelId: "opus", description: "Deeper reasoning" },
    { label: "Claude Best", modelId: "best", description: "Most capable available" },
    { label: "Claude Haiku", modelId: "haiku", description: "Fast, simple tasks" },
    { label: "Claude Opus Plan", modelId: "opusplan", description: "Opus for planning, Sonnet for execution" },
    { label: "Claude Sonnet 1M", modelId: "sonnet[1m]", description: "Long context Sonnet" },
    { label: "Claude Opus 1M", modelId: "opus[1m]", description: "Long context Opus" },
    { label: "Claude Opus 4.7", modelId: "claude-opus-4-7", description: "Pinned Opus 4.7" },
    { label: "Claude Sonnet 4.6", modelId: "claude-sonnet-4-6", description: "Pinned Sonnet 4.6" },
    { label: "Claude Haiku 4.5", modelId: "claude-haiku-4-5", description: "Pinned Haiku 4.5" },
    { label: "Claude Default", modelId: "default", description: "Account default" }
  ],
  codex: [
    { label: "GPT-5.3 Codex", modelId: "gpt-5.3-codex", reasoningEffort: "medium", description: "Agentic coding default" },
    { label: "GPT-5.5", modelId: "gpt-5.5", reasoningEffort: "medium", description: "Frontier professional work" },
    { label: "GPT-5.4", modelId: "gpt-5.4", reasoningEffort: "medium", description: "Balanced coding and cost" },
    { label: "GPT-5.4 Mini", modelId: "gpt-5.4-mini", reasoningEffort: "medium", description: "Lower latency and cost" },
    { label: "GPT-5.4 Nano", modelId: "gpt-5.4-nano", reasoningEffort: "low", description: "Small, cheap tasks" },
    { label: "GPT-5.2", modelId: "gpt-5.2", reasoningEffort: "medium", description: "Previous frontier model" },
    {
      label: "GPT-5.3 Codex Spark",
      modelId: "gpt-5.3-codex-spark",
      reasoningEffort: "low",
      description: "Fast research preview",
      badge: "Preview"
    }
  ]
};

export const PROVIDER_MODEL_DEFAULTS: Record<ProviderId, ProviderModelDefault> = {
  claude: {
    label: "Claude Sonnet",
    modelId: "sonnet",
    launchMode: "structured-json"
  },
  codex: {
    label: "GPT-5.3 Codex",
    modelId: "gpt-5.3-codex",
    reasoningEffort: "medium",
    launchMode: "structured-json"
  }
};

export function modelSelectionForProvider(provider: ProviderId, modelId: string): ProviderModelSelection | null {
  const option = PROVIDER_MODELS[provider].find((model) => model.modelId === modelId);
  if (!option) {
    return null;
  }
  return {
    label: option.label,
    modelId: option.modelId,
    ...(option.reasoningEffort ? { reasoningEffort: option.reasoningEffort } : {})
  };
}
