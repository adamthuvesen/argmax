import type { ProviderId } from "./types.js";

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface ProviderModelDefault {
  label: string;
  modelId: string;
  reasoningEffort?: ReasoningEffort;
}

export const PROVIDER_MODEL_DEFAULTS: Record<ProviderId, ProviderModelDefault> = {
  claude: {
    label: "Claude Sonnet 4.6",
    modelId: "claude-sonnet-4-6"
  },
  codex: {
    label: "GPT-5.5 Medium",
    modelId: "gpt-5.5",
    reasoningEffort: "medium"
  }
};
