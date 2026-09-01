import { Bot, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, type JSX, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { SessionSummary, TimelineEvent, WorkspaceSummary } from "../../shared/types.js";
import type { SubagentTabsState } from "../hooks/useSubagentTabs.js";
import { buildAgentActivity, type AgentModel } from "../lib/agentActivity.js";
import { assignAgentCodenames, fallbackCodename } from "../lib/agentNames.js";
import { buildSessionToolCalls } from "../lib/sessionConversationModel.js";
import type { ToolCall } from "../lib/toolCalls.js";
import { AgentActivity } from "./AgentActivity.js";
import type { FileChipOpenOptions } from "./FileChip.js";
import { WorkingNest } from "./WorkingNest.js";

type AgentStatus = "running" | "done" | "error" | "missing";

/** The state in words. The panel says it once, in the status bar, so the tabs
 *  and the transcript stay free of status chrome. */
function statusLabel(status: AgentStatus): string {
  switch (status) {
    case "running":
      return "Working";
    case "done":
      return "Done";
    case "error":
      return "Error";
    case "missing":
      return "Missing";
  }
}

function modelTitle(model: AgentModel): string {
  return model.effort ? `${model.label} · ${model.effort} reasoning effort` : model.label;
}

/**
 * The review panel's Agents view: one tab per open subagent of this pane's
 * session, the active one's transcript below, and its model and state in the
 * panel's status bar. Every tab stays mounted (inactive ones hidden by CSS) so
 * each keeps loading and polling its own activity in the background.
 */
export function AgentsView({
  events,
  isFocused,
  parentSession,
  subagents,
  workspace,
  onLoadAgentEvents,
  onLoadSessionEvents,
  onOpenAgent,
  onOpenFile
}: {
  events: TimelineEvent[];
  isFocused?: boolean;
  parentSession: SessionSummary | null;
  subagents: SubagentTabsState;
  workspace: WorkspaceSummary | null;
  onLoadAgentEvents?: (sessionId: string, parentToolUseId: string) => Promise<void>;
  onLoadSessionEvents?: (sessionId: string) => Promise<void>;
  onOpenAgent?: (tool: ToolCall) => void;
  onOpenFile?: (path: string, opts?: FileChipOpenOptions) => void;
}): JSX.Element {
  const { toolUseIds, activeToolUseId } = subagents;
  // `activeToolUseId` is kept inside the list, but a tab closed in the same
  // render still has to resolve to something to show.
  const activeId = activeToolUseId ?? toolUseIds[0] ?? null;

  const tabs = useMemo(() => {
    const sessionRunning = parentSession?.state === "running";
    const codenames = assignAgentCodenames(buildSessionToolCalls(events, sessionRunning));
    return toolUseIds.map((id) => {
      const activity = buildAgentActivity({
        parentToolUseId: id,
        events,
        sessionRunning,
        provider: parentSession?.provider
      });
      return {
        id,
        title: activity.title,
        status: activity.status,
        model: activity.model,
        codename: codenames.get(id) ?? fallbackCodename(id)
      };
    });
  }, [events, parentSession?.provider, parentSession?.state, toolUseIds]);

  const active = tabs.find((tab) => tab.id === activeId) ?? null;

  // Drop a tab whose launch row left the timeline: Codex supersedes a synthetic
  // spawn with the real one, and the tab that pointed at the old id would sit
  // here showing an empty transcript forever. Guarded on having events at all,
  // so a backfill in flight never reads as "every launch is gone".
  const { closeTab } = subagents;
  useEffect(() => {
    if (events.length === 0) return;
    for (const tab of tabs) {
      if (tab.status === "missing") closeTab(tab.id);
    }
  }, [closeTab, events.length, tabs]);

  const tabButtonRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const setTabButtonRef = useCallback(
    (tabId: string) =>
      (node: HTMLButtonElement | null): void => {
        if (node === null) tabButtonRefs.current.delete(tabId);
        else tabButtonRefs.current.set(tabId, node);
      },
    []
  );

  const handleTabKeyDown = useCallback(
    (tabId: string) =>
      (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
        const currentIndex = toolUseIds.indexOf(tabId);
        if (currentIndex === -1) return;
        const focusTab = (next: string | undefined): void => {
          if (!next) return;
          event.preventDefault();
          subagents.selectTab(next);
          tabButtonRefs.current.get(next)?.focus();
        };
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          const delta = event.key === "ArrowLeft" ? -1 : 1;
          focusTab(toolUseIds[(currentIndex + delta + toolUseIds.length) % toolUseIds.length]);
          return;
        }
        if (event.key === "Home") {
          focusTab(toolUseIds[0]);
          return;
        }
        if (event.key === "End") {
          focusTab(toolUseIds[toolUseIds.length - 1]);
          return;
        }
        if (event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault();
          subagents.closeTab(tabId);
        }
      },
    [subagents, toolUseIds]
  );

  if (toolUseIds.length === 0) {
    return (
      <div className="review-agents">
        <p className="review-empty">
          <span className="review-empty-mark" aria-hidden="true">∅</span>
          <span>No subagents open. Open one from a launch row in the transcript.</span>
        </p>
      </div>
    );
  }

  return (
    <div className="review-agents">
      <div className="file-tabs-shell">
        <div className="file-tabs" role="tablist" aria-label="Subagents">
          {tabs.map((tab) => {
            const isActive = tab.id === activeId;
            return (
              <div className="file-tab" data-active={isActive ? "true" : "false"} key={tab.id}>
                <button
                  ref={setTabButtonRef(tab.id)}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  aria-controls={`review-agent-${tab.id}`}
                  id={`review-agent-tab-${tab.id}`}
                  tabIndex={isActive ? 0 : -1}
                  title={tab.title}
                  onClick={() => subagents.selectTab(tab.id)}
                  onKeyDown={handleTabKeyDown(tab.id)}
                >
                  <span className="file-tab-icon" data-status={tab.status} aria-hidden="true">
                    {tab.status === "running" ? (
                      <WorkingNest active size={11} phaseKey={tab.id} />
                    ) : (
                      <Bot size={13} />
                    )}
                  </span>
                  <span className="file-tab-name">{tab.codename}</span>
                </button>
                <button
                  type="button"
                  className="file-tab-close"
                  aria-label={`Close ${tab.codename}`}
                  title={`Close ${tab.codename}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    subagents.closeTab(tab.id);
                  }}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="review-agents-body">
        {tabs.map((tab) => {
          const isActive = tab.id === activeId;
          return (
            <div
              key={tab.id}
              className="review-agents-transcript"
              data-active={isActive ? "true" : "false"}
              role="tabpanel"
              id={`review-agent-${tab.id}`}
              aria-labelledby={`review-agent-tab-${tab.id}`}
              aria-hidden={isActive ? undefined : true}
            >
              <AgentActivity
                events={events}
                codename={tab.codename}
                isFocused={isFocused && isActive}
                onLoadAgentEvents={onLoadAgentEvents}
                onLoadSessionEvents={onLoadSessionEvents}
                onOpenAgent={onOpenAgent}
                onOpenFile={onOpenFile}
                parentSession={parentSession}
                parentToolUseId={tab.id}
                workspace={workspace}
              />
            </div>
          );
        })}
      </div>

      {active ? (
        <div className="review-status-bar" aria-label="Subagent status">
          <span className="review-agents-state" data-status={active.status}>
            {active.status === "running" ? (
              <WorkingNest active size={11} phaseKey={active.id} />
            ) : null}
            {statusLabel(active.status)}
          </span>
          {active.model ? (
            <span className="review-agents-model" title={modelTitle(active.model)}>
              {active.model.label}
              {active.model.effort ? (
                <span className="review-agents-effort"> · {active.model.effort}</span>
              ) : null}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
