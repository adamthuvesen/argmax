import { useCallback, useState } from "react";

export const SIDEBAR_TOKENS_KEY = "argmax.sidebar.tokens.visible";
export const CHAT_COST_KEY = "argmax.chat.cost.visible";
export const THINKING_EXPANDED_KEY = "argmax.thinking.expanded";
export const TOOL_CALLS_EXPANDED_KEY = "argmax.toolCalls.expanded";
export const TOOL_CALL_GROUPS_EXPANDED_KEY = "argmax.toolCalls.groups.expanded";
export const LAUNCHER_GLOBE_KEY = "argmax.launcher.globe.visible";

function readBooleanPreference(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  return raw === null ? fallback : raw === "true";
}

export function writeBooleanPreference(key: string, value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Quota or private-mode failures are non-fatal for appearance prefs.
  }
}

export function readStoredSidebarTokensVisible(): boolean {
  return readBooleanPreference(SIDEBAR_TOKENS_KEY, false);
}

export function readStoredChatCostVisible(): boolean {
  return readBooleanPreference(CHAT_COST_KEY, false);
}

export function readStoredThinkingExpanded(): boolean {
  return readBooleanPreference(THINKING_EXPANDED_KEY, false);
}

export function readStoredToolCallsExpanded(): boolean {
  return readBooleanPreference(TOOL_CALLS_EXPANDED_KEY, false);
}

export function readStoredToolCallGroupsExpanded(): boolean {
  return readBooleanPreference(TOOL_CALL_GROUPS_EXPANDED_KEY, false);
}

export function readStoredLauncherGlobeVisible(): boolean {
  return readBooleanPreference(LAUNCHER_GLOBE_KEY, false);
}

/** Boolean UI preference with mirrored localStorage persistence. */
export function useBooleanUiPreference(key: string, fallback: boolean): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => readBooleanPreference(key, fallback));
  const setPreference = useCallback(
    (next: boolean) => {
      setValue(next);
      writeBooleanPreference(key, next);
    },
    [key]
  );
  return [value, setPreference];
}
