import type { ProviderId } from "./types.js";

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type ProviderLaunchMode = "interactive-pty" | "structured-json";

export interface ProviderModelDefault {
  label: string;
  modelId: string;
  reasoningEffort?: ReasoningEffort;
  launchMode: ProviderLaunchMode;
}

export const PROVIDER_MODEL_DEFAULTS: Record<ProviderId, ProviderModelDefault> = {
  claude: {
    label: "Claude Haiku",
    modelId: "haiku",
    launchMode: "structured-json"
  },
  codex: {
    label: "GPT-5.3 Codex Spark Low",
    modelId: "gpt-5.3-codex-spark",
    reasoningEffort: "low",
    launchMode: "interactive-pty"
  }
};
