import { useCallback, useState } from "react";

/**
 * The subagents open in the review panel's Agents view, in the order they were
 * opened. One list per pane, because a subagent belongs to that pane's session.
 */
export interface SubagentTabsState {
  toolUseIds: string[];
  /** Always a member of `toolUseIds`, or null when none are open. */
  activeToolUseId: string | null;
  selectTab: (parentToolUseId: string) => void;
  closeTab: (parentToolUseId: string) => void;
}

export interface SubagentTabs extends SubagentTabsState {
  openTab: (parentToolUseId: string) => void;
  resetForSourceChange: () => void;
}

export function useSubagentTabs(): SubagentTabs {
  const [toolUseIds, setToolUseIds] = useState<string[]>([]);
  const [activeToolUseId, setActiveToolUseId] = useState<string | null>(null);

  const openTab = useCallback((parentToolUseId: string): void => {
    setToolUseIds((current) =>
      current.includes(parentToolUseId) ? current : [...current, parentToolUseId]
    );
    setActiveToolUseId(parentToolUseId);
  }, []);

  const selectTab = useCallback((parentToolUseId: string): void => {
    setActiveToolUseId((current) => (current === parentToolUseId ? current : parentToolUseId));
  }, []);

  // Closing the active tab activates the right neighbour, else the left — the
  // rule the file tabs beside it already follow.
  const closeTab = useCallback(
    (parentToolUseId: string): void => {
      const index = toolUseIds.indexOf(parentToolUseId);
      if (index === -1) return;
      const remaining = toolUseIds.filter((openId) => openId !== parentToolUseId);
      setToolUseIds(remaining);
      if (activeToolUseId === parentToolUseId) {
        setActiveToolUseId(remaining[index] ?? remaining[index - 1] ?? null);
      }
    },
    [activeToolUseId, toolUseIds]
  );

  const resetForSourceChange = useCallback((): void => {
    setToolUseIds([]);
    setActiveToolUseId(null);
  }, []);

  return { toolUseIds, activeToolUseId, openTab, selectTab, closeTab, resetForSourceChange };
}
