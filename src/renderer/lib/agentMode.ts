import type { AgentMode } from "../../shared/types.js";

export const AGENT_MODE_LABELS: Record<AgentMode, string> = {
  auto: "Auto",
  plan: "Plan"
};

export const LAUNCH_AGENT_MODE_KEY = "argmax.launch.agentMode";

export function sessionAgentModeKey(sessionId: string): string {
  return `argmax.sessionAgentMode.${sessionId}`;
}

export function readStoredAgentMode(key: string, fallback: AgentMode = "auto"): AgentMode {
  if (typeof window === "undefined") return fallback;
  const stored = window.localStorage.getItem(key);
  return stored === "plan" || stored === "auto" ? stored : fallback;
}

export function writeStoredAgentMode(key: string, mode: AgentMode): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, mode);
}

export function toggleAgentMode(mode: AgentMode): AgentMode {
  return mode === "plan" ? "auto" : "plan";
}
