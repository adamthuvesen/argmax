import { useCallback, useState } from "react";

export const SIDEBAR_TOKENS_KEY = "argmax.sidebar.tokens.visible";
export const SIDEBAR_COLLAPSED_KEY = "argmax.sidebar.collapsed";
export const CHAT_COST_KEY = "argmax.chat.cost.visible";
export const THINKING_EXPANDED_KEY = "argmax.thinking.expanded";
export const TOOL_CALLS_EXPANDED_KEY = "argmax.toolCalls.expanded";
export const TOOL_CALL_GROUPS_EXPANDED_KEY = "argmax.toolCalls.groups.expanded";
export const FAST_MODE_KEY = "argmax.fastMode.enabled";
export const COMPOSER_PIXEL_FIELD_KEY = "argmax.composer.pixelField.enabled";

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

/**
 * Read an integer UI preference (a persisted pixel size), clamped into
 * `[min, max]`. A missing or non-numeric value returns `fallback`; a stored
 * value outside the range clamps to the nearest bound rather than resetting —
 * so a width saved under an older min/max survives instead of snapping back.
 */
export function readBoundedNumberPreference(
  key: string,
  { min, max, fallback }: { min: number; max: number; fallback: number }
): number {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
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
