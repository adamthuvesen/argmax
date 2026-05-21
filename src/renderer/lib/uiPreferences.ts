export const SIDEBAR_TOKENS_KEY = "argmax.sidebar.tokens.visible";
export const CHAT_COST_KEY = "argmax.chat.cost.visible";
export const TOOL_CALLS_EXPANDED_KEY = "argmax.toolCalls.expanded";
export const TOOL_CALL_GROUPS_EXPANDED_KEY = "argmax.toolCalls.groups.expanded";

function readBooleanPreference(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  return raw === null ? fallback : raw === "true";
}

export function readStoredSidebarTokensVisible(): boolean {
  return readBooleanPreference(SIDEBAR_TOKENS_KEY, false);
}

export function readStoredChatCostVisible(): boolean {
  return readBooleanPreference(CHAT_COST_KEY, true);
}

export function readStoredToolCallsExpanded(): boolean {
  return readBooleanPreference(TOOL_CALLS_EXPANDED_KEY, true);
}

export function readStoredToolCallGroupsExpanded(): boolean {
  return readBooleanPreference(TOOL_CALL_GROUPS_EXPANDED_KEY, true);
}
