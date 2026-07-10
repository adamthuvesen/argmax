import { Loader2 } from "lucide-react";
import {
  useCallback,
  useMemo,
  useRef,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import type { SessionSummary, TimelineEvent, WorkspaceSummary } from "../../shared/types.js";
import { buildAgentActivity } from "../lib/agentActivity.js";
import { assignAgentCodenames, fallbackCodename } from "../lib/agentNames.js";
import type { AgentGridCell } from "../lib/gridState.js";
import type { ToolCall } from "../lib/toolCalls.js";
import { AgentActivityPane } from "./AgentActivityPane.js";

/**
 * All subagents of one parent session share a single grid cell, shown as a
 * tabbed panel. The tab bar only appears with two or more subagents, so a lone
 * subagent looks identical to a plain `AgentActivityPane`. Every tab stays
 * mounted (inactive ones hidden via CSS) so each pane keeps loading and polling
 * its own activity in the background.
 */
export function AgentTabsPane({
  cell,
  events,
  isFocused,
  parentSession,
  workspace,
  onLoadAgentEvents,
  onLoadSessionEvents,
  onOpenAgent,
  onCloseCell,
  onActivateTab,
  onCloseTab
}: {
  cell: AgentGridCell;
  events: TimelineEvent[];
  isFocused?: boolean;
  parentSession: SessionSummary | null;
  workspace: WorkspaceSummary | null;
  onLoadAgentEvents?: (sessionId: string, parentToolUseId: string) => Promise<void>;
  onLoadSessionEvents?: (sessionId: string) => Promise<void>;
  onOpenAgent?: (tool: ToolCall) => void;
  onCloseCell: () => void;
  onActivateTab: (parentToolUseId: string) => void;
  onCloseTab: (parentToolUseId: string) => void;
}): JSX.Element {
  const { parentToolUseIds, activeParentToolUseId } = cell;
  const showTabBar = parentToolUseIds.length >= 2;
  const parentSessionId = parentSession?.id ?? null;

  const tabs = useMemo(() => {
    const sessionEvents = parentSessionId
      ? events.filter((event) => event.sessionId === parentSessionId)
      : [];
    const sessionRunning = parentSession?.state === "running";
    const codenames = assignAgentCodenames(sessionEvents, sessionRunning);
    return parentToolUseIds.map((id) => {
      const activity = buildAgentActivity({ parentToolUseId: id, events: sessionEvents, sessionRunning });
      return {
        id,
        title: activity.title,
        status: activity.status,
        codename: codenames.get(id) ?? fallbackCodename(id)
      };
    });
  }, [events, parentSessionId, parentSession?.state, parentToolUseIds]);

  const tabButtonRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const setTabButtonRef = useCallback(
    (tabId: string) =>
      (node: HTMLButtonElement | null): void => {
        if (node === null) tabButtonRefs.current.delete(tabId);
        else tabButtonRefs.current.set(tabId, node);
      },
    []
  );
  const focusTab = useCallback((tabId: string): void => {
    tabButtonRefs.current.get(tabId)?.focus();
  }, []);

  const handleTabKeyDown = useCallback(
    (tabId: string) =>
      (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
        const currentIndex = parentToolUseIds.indexOf(tabId);
        if (currentIndex === -1) return;
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          const delta = event.key === "ArrowLeft" ? -1 : 1;
          const nextIndex = (currentIndex + delta + parentToolUseIds.length) % parentToolUseIds.length;
          const next = parentToolUseIds[nextIndex];
          if (!next) return;
          onActivateTab(next);
          focusTab(next);
          return;
        }
        if (event.key === "Home") {
          event.preventDefault();
          const first = parentToolUseIds[0];
          if (!first) return;
          onActivateTab(first);
          focusTab(first);
          return;
        }
        if (event.key === "End") {
          event.preventDefault();
          const last = parentToolUseIds[parentToolUseIds.length - 1];
          if (!last) return;
          onActivateTab(last);
          focusTab(last);
          return;
        }
        if (event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault();
          onCloseTab(tabId);
        }
      },
    [focusTab, onActivateTab, onCloseTab, parentToolUseIds]
  );

  return (
    <div className="agent-tabs-pane">
      {showTabBar ? (
        <div
          className="agent-tab-bar"
          role="tablist"
          aria-label="Subagent tabs"
          aria-orientation="horizontal"
        >
          {tabs.map(({ id, title, status, codename }) => {
            const isActive = id === activeParentToolUseId;
            return (
              <div key={id} className="agent-tab" data-active={isActive}>
                <button
                  ref={setTabButtonRef(id)}
                  type="button"
                  className="agent-tab-label"
                  role="tab"
                  aria-selected={isActive}
                  aria-controls={`agent-tabpanel-${id}`}
                  id={`agent-tab-${id}`}
                  tabIndex={isActive ? 0 : -1}
                  onClick={() => onActivateTab(id)}
                  onKeyDown={handleTabKeyDown(id)}
                  title={title}
                >
                  <span className="agent-tab-status" data-status={status} aria-hidden="true">
                    {status === "running" ? (
                      <Loader2 size={11} className="tool-call-spinner" aria-hidden="true" />
                    ) : (
                      <span className="agent-tab-status-dot" />
                    )}
                  </span>
                  <span className="agent-tab-title">{codename}</span>
                </button>
                <button
                  type="button"
                  className="agent-tab-close"
                  aria-label={`Close ${codename}`}
                  title={`Close ${codename}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseTab(id);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
      <div className="agent-tab-bodies">
        {parentToolUseIds.map((id) => {
          const isActive = id === activeParentToolUseId;
          const codename = tabs.find((tab) => tab.id === id)?.codename;
          return (
            <div
              key={id}
              className="agent-tabpanel"
              data-active={isActive}
              role={showTabBar ? "tabpanel" : undefined}
              id={showTabBar ? `agent-tabpanel-${id}` : undefined}
              aria-labelledby={showTabBar ? `agent-tab-${id}` : undefined}
              aria-hidden={showTabBar && !isActive ? true : undefined}
            >
              <AgentActivityPane
                events={events}
                codename={codename}
                isFocused={isFocused && isActive}
                onClose={onCloseCell}
                onLoadAgentEvents={onLoadAgentEvents}
                onLoadSessionEvents={onLoadSessionEvents}
                onOpenAgent={onOpenAgent}
                parentSession={parentSession}
                parentToolUseId={id}
                workspace={workspace}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
