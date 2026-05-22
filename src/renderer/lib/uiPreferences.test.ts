import { beforeEach, describe, expect, it } from "vitest";
import {
  CHAT_COST_KEY,
  readStoredChatCostVisible,
  readStoredSidebarTokensVisible,
  readStoredToolCallGroupsExpanded,
  readStoredToolCallsExpanded,
  SIDEBAR_TOKENS_KEY,
  TOOL_CALL_GROUPS_EXPANDED_KEY,
  TOOL_CALLS_EXPANDED_KEY
} from "./uiPreferences.js";

describe("uiPreferences", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("uses product defaults when no preference is stored", () => {

    expect(readStoredSidebarTokensVisible()).toBe(false);
    expect(readStoredChatCostVisible()).toBe(true);
    expect(readStoredToolCallsExpanded()).toBe(true);
    expect(readStoredToolCallGroupsExpanded()).toBe(true);
  });

  it("reads explicit boolean strings from localStorage", () => {
    window.localStorage.setItem(SIDEBAR_TOKENS_KEY, "true");
    window.localStorage.setItem(CHAT_COST_KEY, "false");
    window.localStorage.setItem(TOOL_CALLS_EXPANDED_KEY, "false");
    window.localStorage.setItem(TOOL_CALL_GROUPS_EXPANDED_KEY, "false");

    expect(readStoredSidebarTokensVisible()).toBe(true);
    expect(readStoredChatCostVisible()).toBe(false);
    expect(readStoredToolCallsExpanded()).toBe(false);
    expect(readStoredToolCallGroupsExpanded()).toBe(false);
  });
});
