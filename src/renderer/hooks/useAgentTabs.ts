import { useCallback, useState } from "react";

/**
 * What is open in the review panel's Agents dock, in the order it was opened:
 * subagents of this pane's session and multitasks dispatched from it, sharing
 * one tab strip. Ids are encoded by `lib/agentTabs.ts`. One list per pane,
 * because everything in it belongs to that pane's session.
 */
export interface AgentTabsState {
  tabIds: string[];
  /** Always a member of `tabIds`, or null when none are open. */
  activeTabId: string | null;
  selectTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
}

export interface AgentTabs extends AgentTabsState {
  openTab: (tabId: string) => void;
  resetForSourceChange: () => void;
}

export function useAgentTabs(): AgentTabs {
  const [tabIds, setTabIds] = useState<string[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  const openTab = useCallback((tabId: string): void => {
    setTabIds((current) => (current.includes(tabId) ? current : [...current, tabId]));
    setActiveTabId(tabId);
  }, []);

  const selectTab = useCallback((tabId: string): void => {
    setActiveTabId((current) => (current === tabId ? current : tabId));
  }, []);

  // Closing the active tab activates the right neighbour, else the left — the
  // rule the file tabs beside it already follow.
  const closeTab = useCallback(
    (tabId: string): void => {
      const index = tabIds.indexOf(tabId);
      if (index === -1) return;
      const remaining = tabIds.filter((openId) => openId !== tabId);
      setTabIds(remaining);
      if (activeTabId === tabId) {
        setActiveTabId(remaining[index] ?? remaining[index - 1] ?? null);
      }
    },
    [activeTabId, tabIds]
  );

  const resetForSourceChange = useCallback((): void => {
    setTabIds([]);
    setActiveTabId(null);
  }, []);

  return { tabIds, activeTabId, openTab, selectTab, closeTab, resetForSourceChange };
}
