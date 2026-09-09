import { Split, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, type JSX, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type {
  AgentMode,
  ComposerAttachment,
  PendingMessage,
  SessionSummary,
  TimelineEvent,
  WorkspaceSummary
} from "../../shared/types.js";
import type { AgentTabsState } from "../hooks/useAgentTabs.js";
import { buildAgentActivity } from "../lib/agentActivity.js";
import { emblemForCodename, emblemForKey, type Emblem } from "../lib/agentEmblems.js";
import { agentTabId, multitaskTabId, readAgentTab } from "../lib/agentTabs.js";
import { agentRootToolUseId, assignAgentCodenames, codenameForTool, fallbackCodename } from "../lib/agentNames.js";
import type { ModelPickerSelection } from "../lib/models.js";
import { multitaskRowStatus, type MultitaskChild } from "../lib/multitask.js";
import type { ThinkingDisplay, ToolCallsDisplay } from "../lib/uiPreferences.js";
import { buildSessionToolCalls } from "../lib/sessionConversationModel.js";
import { decodeTimelineEvent } from "../lib/canonicalTimeline.js";
import type { ToolCall } from "../lib/toolCalls.js";
import { AgentActivity } from "./AgentActivity.js";
import type { NativeAgentIdentity } from "../../shared/types.js";
import { AgentEmblem } from "./AgentEmblem.js";
import type { FileChipOpenOptions } from "./FileChip.js";
import { MultitaskPanel } from "./MultitaskPanel.js";
import type { TerminateSessionOptions } from "../hooks/useSessionCommands.js";
import { WorkingNest } from "./WorkingNest.js";

type AgentStatus = "running" | "done" | "error" | "missing";

/** The dock only opens a multitask tab on a surface that wired the session
 *  commands; these keep the optional props honest without a crash if one is
 *  ever missing. */
const noop = async (): Promise<void> => {};

interface DockTab {
  id: string;
  title: string;
  status: AgentStatus;
  /** Tab label: a subagent's codename, a multitask's task label. */
  name: string;
  /** The tab's mark: a subagent's from its codename, a multitask's from its
   *  session id. Null only for a tab whose child has left the timeline. */
  emblem: Emblem | null;
  multitask: MultitaskChild | null;
  rootToolUseId: string | null;
}

/**
 * The review panel's Agents view: one tab per subagent of this pane's session
 * and per multitask dispatched from it, and the active one below. Both kinds
 * sit in one strip because they are one thing to the reader: what else is
 * running for me right now. Every tab stays mounted (inactive ones hidden by
 * CSS) so each keeps loading and polling in the background.
 */
export function AgentsView({
  events,
  defaultToolCallsDisplay,
  defaultToolCallGroupsExpanded,
  thinkingDisplay,
  isFocused,
  multitasks,
  parentSession,
  agentTabs,
  pendingMessages,
  workspace,
  onCancelQueuedMessage,
  onClearSession,
  onLoadAgentEvents,
  onLoadSessionEvents,
  onOpenAgent,
  onOpenDiff,
  onOpenFile,
  onOpenReview,
  onOpenFullChat,
  onSendQueuedMessageNow,
  onSendSessionInput,
  onTerminateSession
}: {
  events: TimelineEvent[];
  /** Chat verbosity, forwarded so a subagent's transcript is as quiet or as
   *  detailed as the chat that launched it. */
  defaultToolCallsDisplay?: ToolCallsDisplay;
  defaultToolCallGroupsExpanded?: boolean;
  thinkingDisplay?: ThinkingDisplay;
  isFocused?: boolean;
  /** Multitasks dispatched from this pane's session, with the workspace each
   *  runs in. Empty when the surface cannot host their chats. */
  multitasks?: MultitaskChild[];
  parentSession: SessionSummary | null;
  agentTabs: AgentTabsState;
  pendingMessages?: Record<string, PendingMessage[]>;
  workspace: WorkspaceSummary | null;
  onCancelQueuedMessage?: (sessionId: string, messageId: string) => Promise<void>;
  onClearSession?: (sessionId: string) => Promise<void>;
  onLoadAgentEvents?: (
    sessionId: string,
    parentToolUseId: string,
    identity?: NativeAgentIdentity
  ) => Promise<void | { hasMore: boolean }>;
  onLoadSessionEvents?: (sessionId: string) => Promise<void>;
  onOpenAgent?: (tool: ToolCall) => void;
  onOpenDiff?: (path: string) => void;
  onOpenFile?: (path: string, opts?: FileChipOpenOptions) => void;
  onOpenReview?: () => void;
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
    const tools = buildSessionToolCalls(
      events,
      sessionRunning,
      parentSession?.state === "failed" || parentSession?.state === "cancelled"
    );
    const codenames = assignAgentCodenames(tools);
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
          status: child ? multitaskRowStatus(child.session.state) : "missing",
          name: label,
          emblem: child ? emblemForKey(child.session.id) : null,
          multitask: child,
          rootToolUseId: null
        };
      }
      const identityTool = tools.find((tool) =>
        agentRootToolUseId(tool) === tab.toolUseId &&
        (!tab.providerParentConversationId || tool.providerParentConversationId === tab.providerParentConversationId) &&
        (!tab.providerChildSessionId || tool.providerChildSessionId === tab.providerChildSessionId)
      );
      const persistedCodename = events.find((event) => {
        const decoded = decodeTimelineEvent(event);
        return decoded.agentRootToolUseId === tab.toolUseId &&
          decoded.providerParentConversationId === tab.providerParentConversationId &&
          decoded.providerChildSessionId === tab.providerChildSessionId &&
          decoded.agentCodename;
      });
      const decodedCodename = persistedCodename
        ? decodeTimelineEvent(persistedCodename).agentCodename
        : null;
      const codename = identityTool
        ? codenameForTool(identityTool, codenames) ?? fallbackCodename(tab.toolUseId)
        : decodedCodename ?? fallbackCodename(tab.toolUseId);
      const activity = buildAgentActivity({
        parentToolUseId: tab.toolUseId,
        events,
        sessionRunning,
        sessionInterrupted: parentSession?.state === "failed" || parentSession?.state === "cancelled",
        provider: parentSession?.provider,
        nativeIdentity: tab.providerParentConversationId && tab.providerChildSessionId
          ? {
              providerParentConversationId: tab.providerParentConversationId,
              providerChildSessionId: tab.providerChildSessionId
            }
          : null
      });
      return {
        id,
        title: activity.title,
        status: activity.status,
        name: codename,
        emblem: emblemForCodename(codename),
        multitask: null,
        rootToolUseId: tab.toolUseId
      };
    });
  }, [events, multitasks, parentSession?.provider, parentSession?.state, tabIds]);

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

  // A launch can be opened before Claude reports its native child id. Upgrade
  // that provisional raw-tool tab in place once identity arrives. Selection
  // and order stay unchanged, so a background continuation never steals focus.
  useEffect(() => {
    if (!parentSession) return;
    for (const id of tabIds) {
      const tab = readAgentTab(id);
      if (tab.kind !== "subagent" || tab.providerChildSessionId) continue;
      const activity = buildAgentActivity({
        parentToolUseId: tab.toolUseId,
        events,
        sessionRunning: parentSession.state === "running",
        sessionInterrupted: parentSession.state === "failed" || parentSession.state === "cancelled",
        provider: parentSession.provider
      });
      if (!activity.parentTool) continue;
      const durableId = agentTabId(activity.parentTool);
      if (durableId !== id) agentTabs.replaceTab?.(id, durableId);
    }
  }, [agentTabs, events, parentSession, tabIds]);

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
                  <span
                    className={tab.emblem ? "file-tab-icon agent-emblem-tint" : "file-tab-icon"}
                    data-status={tab.status}
                    data-hue={tab.emblem?.hue}
                    aria-hidden="true"
                  >
                    {tab.status === "running" ? (
                      <WorkingNest active size={11} phaseKey={tab.id} />
                    ) : tab.emblem ? (
                      <AgentEmblem
                        shape={tab.emblem.shape}
                        hue={tab.emblem.hue}
                        size={13}
                        status={tab.status === "error" ? "error" : "done"}
                      />
                    ) : (
                      <Split size={13} />
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
                  pendingMessages={pendingMessages?.[tab.multitask.session.id] ?? []}
                  session={tab.multitask.session}
                  taskLabel={tab.name}
                  workspace={tab.multitask.workspace}
                  onCancelQueuedMessage={onCancelQueuedMessage ?? noop}
                  onClearSession={onClearSession ?? noop}
                  onOpenDiff={onOpenDiff}
                  onOpenFile={onOpenFile}
                  onOpenReview={onOpenReview}
                  onLoadSessionEvents={onLoadSessionEvents}
                  onOpenFullChat={onOpenFullChat}
                  onSendQueuedMessageNow={onSendQueuedMessageNow ?? noop}
                  onSendSessionInput={onSendSessionInput ?? noop}
                  onTerminateSession={onTerminateSession ?? noop}
                />
              ) : (
                <AgentActivity
                  events={events}
                  codename={tab.name}
                  defaultToolCallsDisplay={defaultToolCallsDisplay}
                  defaultToolCallGroupsExpanded={defaultToolCallGroupsExpanded}
                  thinkingDisplay={thinkingDisplay}
                  isFocused={isFocused && isActive}
                  onLoadAgentEvents={onLoadAgentEvents}
                  onLoadSessionEvents={onLoadSessionEvents}
                  onOpenAgent={onOpenAgent}
                  onOpenDiff={onOpenDiff}
                  onOpenFile={onOpenFile}
                  onOpenReview={onOpenReview}
                  parentSession={parentSession}
                  parentToolUseId={tab.rootToolUseId ?? tab.id}
                  nativeIdentity={(() => {
                    const parsed = readAgentTab(tab.id);
                    return parsed.kind === "subagent" && parsed.providerParentConversationId && parsed.providerChildSessionId
                      ? {
                          providerParentConversationId: parsed.providerParentConversationId,
                          providerChildSessionId: parsed.providerChildSessionId
                        }
                      : null;
                  })()}
                  workspace={workspace}
                />
              )}
            </div>
          );
        })}
      </div>

    </div>
  );
}
