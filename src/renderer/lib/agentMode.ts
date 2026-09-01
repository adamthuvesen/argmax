import type { AgentMode } from "../../shared/types.js";

/** Launcher chip: Auto and Plan attach a project, Chat launches a scratch workspace. */
export type LauncherMode = AgentMode | "chat";

export const AGENT_MODE_LABELS: Record<AgentMode, string> = {
  auto: "Auto",
  plan: "Plan"
};

export const LAUNCHER_MODE_LABELS: Record<LauncherMode, string> = {
  auto: "Auto",
  plan: "Plan",
  chat: "Chat"
};

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

export function cycleLauncherMode(mode: LauncherMode, chatAvailable: boolean): LauncherMode {
  switch (mode) {
    case "auto":
      return "plan";
    case "plan":
      return chatAvailable ? "chat" : "auto";
    case "chat":
      return "auto";
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}

/** Chat is a workspace choice, not a provider flag. Scratch launches run Auto. */
export function agentModeForLaunch(mode: LauncherMode): AgentMode {
  return mode === "chat" ? "auto" : mode;
}

export function launcherModeTitle(mode: LauncherMode, chatAvailable: boolean): string {
  switch (mode) {
    case "auto":
      return "Auto: the agent works and approves its own steps. Tab for Plan.";
    case "plan":
      return chatAvailable
        ? "Plan: the agent drafts a plan before touching anything. Tab for Chat."
        : "Plan: the agent drafts a plan before touching anything. Tab for Auto.";
    case "chat":
      return "Chat: no repository attached. Tab for Auto.";
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}
