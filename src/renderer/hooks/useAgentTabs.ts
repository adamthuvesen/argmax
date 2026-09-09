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
  closeAllTabs: () => void;
  replaceTab?: (fromTabId: string, toTabId: string) => void;
}

export interface AgentTabs extends AgentTabsState {
  openTab: (tabId: string) => void;
  replaceTab: (fromTabId: string, toTabId: string) => void;
  /** The same clear as `closeAllTabs`, under the name the sibling review
   *  hooks share. */
  resetForSourceChange: () => void;
}

export function useAgentTabs(): AgentTabs {
  const [{ tabIds, activeTabId }, setTabs] = useState<Pick<AgentTabsState, "tabIds" | "activeTabId">>({
    tabIds: [],
    activeTabId: null
  });

  const openTab = useCallback((tabId: string): void => {
    setTabs((current) => ({
      tabIds: current.tabIds.includes(tabId) ? current.tabIds : [...current.tabIds, tabId],
      activeTabId: tabId
    }));
  }, []);

  const selectTab = useCallback((tabId: string): void => {
    setTabs((current) => current.activeTabId === tabId ? current : { ...current, activeTabId: tabId });
  }, []);

  // Closing the active tab activates the right neighbour, else the left — the
  // rule the file tabs beside it already follow.
  const closeTab = useCallback((tabId: string): void => {
    setTabs((current) => {
      const index = current.tabIds.indexOf(tabId);
      if (index === -1) return current;
      const remaining = current.tabIds.filter((openId) => openId !== tabId);
      return {
        tabIds: remaining,
        activeTabId: current.activeTabId === tabId
          ? remaining[index] ?? remaining[index - 1] ?? null
          : current.activeTabId
      };
    });
  }, []);

  const closeAllTabs = useCallback((): void => {
    setTabs({ tabIds: [], activeTabId: null });
  }, []);

  const replaceTab = useCallback((fromTabId: string, toTabId: string): void => {
    if (fromTabId === toTabId) return;
    setTabs((current) => ({
      tabIds: current.tabIds.map((id) => id === fromTabId ? toTabId : id)
        .filter((id, index, all) => all.indexOf(id) === index),
      activeTabId: current.activeTabId === fromTabId ? toTabId : current.activeTabId
    }));
  }, []);

  return { tabIds, activeTabId, openTab, selectTab, closeTab, replaceTab, closeAllTabs, resetForSourceChange: closeAllTabs };
}
