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
import { agentTabId, multitaskTabId, readAgentTab } from "../lib/agentTabs.js";
import { agentRootToolUseId, assignAgentCodenames, codenameForTool, fallbackCodename } from "../lib/agentNames.js";
import type { FontSize } from "../lib/fonts.js";
import type { ModelPickerSelection } from "../lib/models.js";
import { multitaskRowStatus, type MultitaskChild } from "../lib/multitask.js";
import type { ThinkingDisplay, ToolCallsDisplay } from "../lib/uiPreferences.js";
import { buildSessionToolCalls } from "../lib/sessionConversationModel.js";
import { buildAgentRoster, newestAgentFirst, type AgentRosterEntry } from "../lib/agentRoster.js";
import { decodeTimelineEvent } from "../lib/canonicalTimeline.js";
import type { ToolCall } from "../lib/toolCalls.js";
import { AgentActivity } from "./AgentActivity.js";
import type { NativeAgentIdentity } from "../../shared/types.js";
import { AgentEmblem } from "./AgentEmblem.js";
import type { FileChipOpenOptions } from "./FileChip.js";
import { MultitaskPanel } from "./MultitaskPanel.js";
import type { TerminateSessionOptions } from "../hooks/useSessionCommands.js";
import { WorkingNest } from "./WorkingNest.js";
import { AgentRosterPopover } from "./AgentRosterPopover.js";

type AgentStatus = "running" | "done" | "error" | "missing";

const ACTIVE_STRIP_LIMIT = 4;

function stripPriority(entry: AgentRosterEntry, activeId: string | null): number {
  if (entry.id === activeId) return 0;
  if (entry.status === "error") return 1;
  return 2;
}

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
  multitask: MultitaskChild | null;
  rootToolUseId: string | null;
}

/**
 * The review panel's Agents view: one tab per subagent of this pane's session
 * and per multitask dispatched from it, and the active one below. Both kinds
 * sit in one strip because they are one thing to the reader: what else is
 * running for me right now. Every tab stays mounted (inactive ones hidden by
 * CSS) so switching back is instant, but only the shown subagent polls; a tab
 * reloads the moment it is shown again.
 */
export function AgentsView({
  chatFontSize,
  events,
  defaultToolCallsDisplay,
  defaultToolCallGroupsExpanded,
  thinkingDisplay,
  isFocused,
  multitasks,
  parentSession,
  agentTabs,
  pendingMessages,
  stripLimit = ACTIVE_STRIP_LIMIT,
  workspace,
  onCancelQueuedMessage,
  onClearSession,
  onDiscoverTabs,
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
  /** Settings → Appearance: the agent-window scale shared by delegated chats. */
  chatFontSize?: FontSize;
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
  /** Mobile keeps fewer live identities ahead of the fixed roster control. */
  stripLimit?: number;
  workspace: WorkspaceSummary | null;
  onCancelQueuedMessage?: (sessionId: string, messageId: string) => Promise<void>;
  onClearSession?: (sessionId: string) => Promise<void>;
  /** The desktop dock discovers available work when opened directly. */
  onDiscoverTabs?: (tabIds: string[]) => void;
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

  const tools = useMemo(() => buildSessionToolCalls(
    events,
    parentSession?.state === "running",
    parentSession?.state === "failed" || parentSession?.state === "cancelled"
  ), [events, parentSession?.state]);
  const codenames = useMemo(() => assignAgentCodenames(tools), [tools]);
  const roster = useMemo(
    () => buildAgentRoster(tools, codenames, multitasks),
    [codenames, multitasks, tools]
  );
  const orderedRoster = useMemo(() => [...roster.entries].sort((a, b) => {
    const statusOrder = { running: 0, error: 1, done: 2 } as const;
    const status = statusOrder[a.status] - statusOrder[b.status];
    return status || newestAgentFirst(a, b);
  }), [roster.entries]);

  const discoveredTabs = useRef(new Set<string>());
  const provisionalDiscoveries = useRef(new Set<string>());
  useEffect(() => {
    if (!onDiscoverTabs) return;
    const ids = orderedRoster.map((entry) => entry.id);
    // Remember discoveries for this visit so live updates respect closed tabs.
    // Remounting the dock discovers all available work again.
    const newIds: string[] = [];
    for (const id of ids) {
      if (discoveredTabs.current.has(id)) continue;
      discoveredTabs.current.add(id);
      const tab = readAgentTab(id);
      if (tab.kind === "subagent") {
        if (tab.providerChildSessionId) {
          // Native identity enriches an existing launch. The upgrade effect
          // handles an open tab, and a closed provisional tab stays closed.
          if (provisionalDiscoveries.current.delete(tab.toolUseId)) continue;
        } else {
          provisionalDiscoveries.current.add(tab.toolUseId);
        }
      }
      newIds.push(id);
    }
    if (newIds.length > 0) onDiscoverTabs(newIds);
  }, [onDiscoverTabs, orderedRoster]);

  const tabs = useMemo((): DockTab[] => {
    const sessionRunning = parentSession?.state === "running";
    const childrenByTabId = new Map(
      (multitasks ?? []).map((child) => [multitaskTabId(child.session.id), child])
    );
    const openOrder = tabIds.map((id): DockTab => {
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
        multitask: null,
        rootToolUseId: tab.toolUseId
      };
    });
    // Newest launch leftmost, with everything still running ahead of the rest,
    // so what is active is visible without scrolling the strip once it fills.
    // `tabIds` is discovery order, oldest first; sorting is stable so ties keep it.
    const launchIndex = new Map(openOrder.map((tab, index) => [tab.id, index]));
    return [...openOrder].sort((a, b) => {
      const activeFirst = Number(b.status === "running") - Number(a.status === "running");
      if (activeFirst !== 0) return activeFirst;
      return (launchIndex.get(b.id) ?? 0) - (launchIndex.get(a.id) ?? 0);
    });
  }, [codenames, events, multitasks, parentSession?.provider, parentSession?.state, tabIds, tools]);
  const stripEntries = useMemo(() => roster.entries
    .filter((entry) => entry.status !== "done" || entry.id === activeId)
    .sort((a, b) => {
      const priority = stripPriority(a, activeId) - stripPriority(b, activeId);
      return priority || newestAgentFirst(a, b);
    }), [activeId, roster.entries]);
  const visibleStripEntries = stripEntries.slice(0, stripLimit);
  // Keyboard navigation walks only the tabs that are actually drawn. The full
  // roster has its own vertical listbox navigation.
  const orderedTabIds = visibleStripEntries.map((entry) => entry.id);
  const visibleStripIds = new Set(visibleStripEntries.map((entry) => entry.id));
  const activeOverflow = Math.max(0, stripEntries.length - visibleStripEntries.length);
  const selectRosterEntry = useCallback((id: string): void => {
    agentTabs.openTabs?.([id]);
    agentTabs.selectTab(id);
  }, [agentTabs]);

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
        const currentIndex = orderedTabIds.indexOf(tabId);
        if (currentIndex === -1) return;
        const focusTab = (next: string | undefined): void => {
          if (!next) return;
          event.preventDefault();
          agentTabs.selectTab(next);
          tabButtonRefs.current.get(next)?.focus();
        };
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          const delta = event.key === "ArrowLeft" ? -1 : 1;
          focusTab(orderedTabIds[(currentIndex + delta + orderedTabIds.length) % orderedTabIds.length]);
          return;
        }
        if (event.key === "Home") {
          focusTab(orderedTabIds[0]);
          return;
        }
        if (event.key === "End") {
          focusTab(orderedTabIds[orderedTabIds.length - 1]);
          return;
        }
      },
    [agentTabs, orderedTabIds]
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
      <div className="file-tabs-shell agent-tabs-shell">
        <div className="file-tabs agent-active-tabs" role="tablist" aria-label="Subagents and multitasks">
          {visibleStripEntries.map((entry) => {
            const isActive = entry.id === activeId;
            return (
              <div className="file-tab" data-active={isActive ? "true" : "false"} key={entry.id}>
                <button
                  ref={setTabButtonRef(entry.id)}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  aria-controls={`review-agent-${entry.id}`}
                  id={`review-agent-tab-${entry.id}`}
                  tabIndex={isActive ? 0 : -1}
                  title={entry.title}
                  onClick={() => selectRosterEntry(entry.id)}
                  onKeyDown={handleTabKeyDown(entry.id)}
                >
                  <span
                    className="file-tab-icon agent-emblem-tint"
                    data-status={entry.status}
                    data-hue={entry.emblem.hue}
                    aria-hidden="true"
                  >
                    {entry.status === "running" ? (
                      <WorkingNest active size={11} phaseKey={entry.id} />
                    ) : (
                      <AgentEmblem
                        shape={entry.emblem.shape}
                        hue={entry.emblem.hue}
                        size={13}
                        status={entry.status === "error" ? "error" : "done"}
                      />
                    )}
                  </span>
                  <span className="file-tab-name">{entry.codename}</span>
                </button>
              </div>
            );
          })}
        </div>
        <AgentRosterPopover
          activeOverflow={activeOverflow}
          activeTabId={activeId}
          entries={roster.entries}
          onSelect={selectRosterEntry}
        />
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
              aria-labelledby={visibleStripIds.has(tab.id) ? `review-agent-tab-${tab.id}` : undefined}
              aria-label={visibleStripIds.has(tab.id) ? undefined : tab.title}
              aria-hidden={isActive ? undefined : true}
            >
              {tab.multitask ? (
                <MultitaskPanel
                  chatFontSize={chatFontSize}
                  defaultToolCallsDisplay={defaultToolCallsDisplay}
                  defaultToolCallGroupsExpanded={defaultToolCallGroupsExpanded}
                  thinkingDisplay={thinkingDisplay}
                  isFocused={Boolean(isFocused && isActive)}
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
                  visible={isActive}
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
