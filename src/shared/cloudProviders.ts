import type { ProviderId } from "./types.js";

export const CLOUD_PROVIDERS = ["claude", "codex", "cursor"] as const;

export type HostedCloudProvider = (typeof CLOUD_PROVIDERS)[number];

export const CLOUD_PROVIDER_NAMES: Record<HostedCloudProvider, string> = {
  claude: "Claude Cloud",
  codex: "Codex Cloud",
  cursor: "Cursor Cloud"
};

/** Where each provider lists its cloud tasks. The dialog points here when a
 *  launch may have created a task Argmax never got a link for. */
export const CLOUD_PROVIDER_TASKS_URLS: Record<HostedCloudProvider, string> = {
  claude: "https://claude.ai/code",
  codex: "https://chatgpt.com/codex",
  cursor: "https://cursor.com/agents"
};

export function isHostedCloudProvider(provider: ProviderId): provider is HostedCloudProvider {
  return CLOUD_PROVIDERS.some((candidate) => candidate === provider);
}

export function cloudProviderName(provider: HostedCloudProvider): string {
  return CLOUD_PROVIDER_NAMES[provider];
}
