import type { ProviderId } from "./types.js";

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
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
    { label: "Claude Sonnet 4.6", modelId: "claude-sonnet-4-6" },
    { label: "Claude Haiku 4.5", modelId: "claude-haiku-4-5" }
  ],
  codex: [
    { label: "Codex Spark", modelId: "gpt-5.3-codex-spark", reasoningEffort: "low", disableReasoningSummary: true },
    { label: "Codex Spark", modelId: "gpt-5.3-codex-spark", reasoningEffort: "medium", disableReasoningSummary: true },
    { label: "Codex Spark", modelId: "gpt-5.3-codex-spark", reasoningEffort: "high", disableReasoningSummary: true },
    { label: "GPT-5.5", modelId: "gpt-5.5", reasoningEffort: "low" },
    { label: "GPT-5.5", modelId: "gpt-5.5", reasoningEffort: "medium" },
    { label: "GPT-5.5", modelId: "gpt-5.5", reasoningEffort: "high" }
  ]
};

export const PROVIDER_MODEL_DEFAULTS: Record<ProviderId, ProviderModelDefault> = {
  claude: {
    label: "Claude Sonnet 4.6",
    modelId: "claude-sonnet-4-6",
    launchMode: "structured-json"
  },
  codex: {
    label: "Codex Spark",
    modelId: "gpt-5.3-codex-spark",
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
