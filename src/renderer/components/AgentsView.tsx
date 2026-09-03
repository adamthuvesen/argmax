import { ArrowUpRight, Bot, Split, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, type JSX, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type {
  AgentMode,
  ComposerAttachment,
  PendingMessage,
  RawProviderOutput,
  SessionSummary,
  TimelineEvent,
  WorkspaceSummary
} from "../../shared/types.js";
import type { AgentTabsState } from "../hooks/useAgentTabs.js";
import { buildAgentActivity, type AgentModel } from "../lib/agentActivity.js";
import { multitaskTabId, readAgentTab } from "../lib/agentTabs.js";
import { assignAgentCodenames, fallbackCodename } from "../lib/agentNames.js";
import type { ModelPickerSelection } from "../lib/models.js";
import type { MultitaskChild } from "../lib/multitask.js";
import { buildSessionToolCalls } from "../lib/sessionConversationModel.js";
import type { ToolCall } from "../lib/toolCalls.js";
import { AgentActivity } from "./AgentActivity.js";
import type { FileChipOpenOptions } from "./FileChip.js";
import { MultitaskPanel } from "./MultitaskPanel.js";
import type { TerminateSessionOptions } from "../hooks/useSessionCommands.js";
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

/** The dock only opens a multitask tab on a surface that wired the session
 *  commands; these keep the optional props honest without a crash if one is
 *  ever missing. */
const noop = async (): Promise<void> => {};

function modelTitle(model: AgentModel): string {
  return model.effort ? `${model.label} · ${model.effort} reasoning effort` : model.label;
}

/** A multitask's chat state in the words the dock uses for a subagent. */
function multitaskStatus(state: string): AgentStatus {
  if (state === "failed" || state === "cancelled") return "error";
  if (state === "complete") return "done";
  return "running";
}

interface DockTab {
  id: string;
  title: string;
  status: AgentStatus;
  model: AgentModel | null;
  /** Tab label: a subagent's codename, a multitask's task label. */
  name: string;
  multitask: MultitaskChild | null;
}

/**
 * The review panel's Agents view: one tab per subagent of this pane's session
 * and per multitask dispatched from it, the active one below, and its model and
 * state in the panel's status bar. Both kinds sit in one strip because they are
 * one thing to the reader — what else is running for me right now. Every tab
 * stays mounted (inactive ones hidden by CSS) so each keeps loading and polling
 * in the background.
 */
export function AgentsView({
  events,
  isFocused,
  multitasks,
  multitaskEvents,
  parentSession,
  agentTabs,
  pendingMessages,
  rawOutputs,
  workspace,
  onCancelQueuedMessage,
  onClearSession,
  onLoadAgentEvents,
  onLoadSessionEvents,
  onOpenAgent,
  onOpenFile,
  onOpenFullChat,
  onSendQueuedMessageNow,
  onSendSessionInput,
  onTerminateSession
}: {
  events: TimelineEvent[];
  isFocused?: boolean;
  /** Multitasks dispatched from this pane's session, with the workspace each
   *  runs in. Empty when the surface cannot host their chats. */
  multitasks?: MultitaskChild[];
  /** Every session's events: a multitask's chat is not this pane's session, so
   *  it cannot read the pane-scoped `events` above. */
  multitaskEvents?: TimelineEvent[];
  parentSession: SessionSummary | null;
  agentTabs: AgentTabsState;
  pendingMessages?: Record<string, PendingMessage[]>;
  rawOutputs?: RawProviderOutput[];
  workspace: WorkspaceSummary | null;
  onCancelQueuedMessage?: (sessionId: string, messageId: string) => Promise<void>;
  onClearSession?: (sessionId: string) => Promise<void>;
  onLoadAgentEvents?: (sessionId: string, parentToolUseId: string) => Promise<void>;
  onLoadSessionEvents?: (sessionId: string) => Promise<void>;
  onOpenAgent?: (tool: ToolCall) => void;
  onOpenFile?: (path: string, opts?: FileChipOpenOptions) => void;
  onOpenFullChat?: (sessionId: string) => void;
  onSendQueuedMessageNow?: (sessionId: string, messageId: string) => Promise<void>;
  onSendSessionInput?: (
    sessionId: string,
    input: string,
    model: ModelPickerSelection,
    agentMode: AgentMode,
    attachments?: ComposerAttachment[]
  ) => Promise<void>;
  onTerminateSession?: (sessionId: string, options?: TerminateSessionOptions) => Promise<void>;
}): JSX.Element {
  const { tabIds, activeTabId } = agentTabs;
  // `activeTabId` is kept inside the list, but a tab closed in the same
  // render still has to resolve to something to show.
  const activeId = activeTabId ?? tabIds[0] ?? null;

  const tabs = useMemo((): DockTab[] => {
    const sessionRunning = parentSession?.state === "running";
    const codenames = assignAgentCodenames(buildSessionToolCalls(events, sessionRunning));
    const childrenByTabId = new Map(
      (multitasks ?? []).map((child) => [multitaskTabId(child.session.id), child])
    );
    return tabIds.map((id) => {
      const tab = readAgentTab(id);
      if (tab.kind === "multitask") {
        const child = childrenByTabId.get(id) ?? null;
        // A multitask whose session is gone from the snapshot is as missing as
        // a subagent whose launch row left the timeline; the effect below
        // closes the tab rather than leaving an empty panel behind.
        const label = child
          ? (child.workspace?.taskLabel ?? child.session.prompt)
          : "Multitask";
        return {
          id,
          title: label,
          status: child ? multitaskStatus(child.session.state) : "missing",
          model: child
            ? { label: child.session.modelLabel, effort: child.session.reasoningEffort ?? null }
            : null,
          name: label,
          multitask: child
        };
      }
      const activity = buildAgentActivity({
        parentToolUseId: tab.toolUseId,
        events,
        sessionRunning,
        provider: parentSession?.provider
      });
      return {
        id,
        title: activity.title,
        status: activity.status,
        model: activity.model,
        name: codenames.get(id) ?? fallbackCodename(id),
        multitask: null
      };
    });
  }, [events, multitasks, parentSession?.provider, parentSession?.state, tabIds]);

  const active = tabs.find((tab) => tab.id === activeId) ?? null;

  // Drop a tab whose launch row left the timeline: Codex supersedes a synthetic
  // spawn with the real one, and the tab that pointed at the old id would sit
  // here showing an empty transcript forever. Guarded on having events at all,
  // so a backfill in flight never reads as "every launch is gone".
  const { closeTab } = agentTabs;
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
        const currentIndex = tabIds.indexOf(tabId);
        if (currentIndex === -1) return;
        const focusTab = (next: string | undefined): void => {
          if (!next) return;
          event.preventDefault();
          agentTabs.selectTab(next);
          tabButtonRefs.current.get(next)?.focus();
        };
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          const delta = event.key === "ArrowLeft" ? -1 : 1;
          focusTab(tabIds[(currentIndex + delta + tabIds.length) % tabIds.length]);
          return;
        }
        if (event.key === "Home") {
          focusTab(tabIds[0]);
          return;
        }
        if (event.key === "End") {
          focusTab(tabIds[tabIds.length - 1]);
          return;
        }
        if (event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault();
          agentTabs.closeTab(tabId);
        }
      },
    [agentTabs, tabIds]
  );

  if (tabIds.length === 0) {
    return (
      <div className="review-agents">
        <p className="review-empty">
          <span className="review-empty-mark" aria-hidden="true">∅</span>
          <span>Nothing open here. Open a subagent or a multitask from a row in the transcript.</span>
        </p>
      </div>
    );
  }

  return (
    <div className="review-agents">
      <div className="file-tabs-shell">
        <div className="file-tabs" role="tablist" aria-label="Subagents and multitasks">
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
                  onClick={() => agentTabs.selectTab(tab.id)}
                  onKeyDown={handleTabKeyDown(tab.id)}
                >
                  <span className="file-tab-icon" data-status={tab.status} aria-hidden="true">
                    {tab.status === "running" ? (
                      <WorkingNest active size={11} phaseKey={tab.id} />
                    ) : tab.multitask ? (
                      <Split size={13} />
                    ) : (
                      <Bot size={13} />
                    )}
                  </span>
                  <span className="file-tab-name">{tab.name}</span>
                </button>
                <button
                  type="button"
                  className="file-tab-close"
                  aria-label={`Close ${tab.name}`}
                  title={`Close ${tab.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    agentTabs.closeTab(tab.id);
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
              {tab.multitask ? (
                <MultitaskPanel
                  events={multitaskEvents ?? events}
                  pendingMessages={pendingMessages?.[tab.multitask.session.id] ?? []}
                  rawOutputs={rawOutputs ?? []}
                  session={tab.multitask.session}
                  taskLabel={tab.name}
                  workspace={tab.multitask.workspace}
                  onCancelQueuedMessage={onCancelQueuedMessage ?? noop}
                  onClearSession={onClearSession ?? noop}
                  onOpenFile={onOpenFile}
                  onLoadSessionEvents={onLoadSessionEvents}
                  onSendQueuedMessageNow={onSendQueuedMessageNow ?? noop}
                  onSendSessionInput={onSendSessionInput ?? noop}
                  onTerminateSession={onTerminateSession ?? noop}
                />
              ) : (
                <AgentActivity
                  events={events}
                  codename={tab.name}
                  isFocused={isFocused && isActive}
                  onLoadAgentEvents={onLoadAgentEvents}
                  onLoadSessionEvents={onLoadSessionEvents}
                  onOpenAgent={onOpenAgent}
                  onOpenFile={onOpenFile}
                  parentSession={parentSession}
                  parentToolUseId={tab.id}
                  workspace={workspace}
                />
              )}
            </div>
          );
        })}
      </div>

      {active ? (
        <div className="review-status-bar" aria-label="Agent status">
          <span className="review-agents-state" data-status={active.status}>
            {active.status === "running" ? (
              <WorkingNest active size={11} phaseKey={active.id} />
            ) : null}
            {statusLabel(active.status)}
          </span>
          {/* A multitask's own composer already names its model, and the way out
              of the dock belongs on this strip rather than in a band of its
              own above it. */}
          {active.multitask ? (
            onOpenFullChat ? (
              <button
                type="button"
                className="review-agents-open"
                title="Open this multitask as a full chat"
                onClick={() => onOpenFullChat(active.multitask?.session.id ?? "")}
              >
                Open as full chat
                <ArrowUpRight size={12} aria-hidden="true" />
              </button>
            ) : null
          ) : active.model ? (
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
