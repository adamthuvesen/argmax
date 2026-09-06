import { ArrowDown, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import type { NativeAgentIdentity, SessionSummary, TimelineEvent, WorkspaceSummary } from "../../shared/types.js";
import { useRestoreWithoutMotion } from "../hooks/useRestoreWithoutMotion.js";
import { SCROLL_INTENT_KEYS, useSmartFollowScroll } from "../hooks/useSmartFollowScroll.js";
import { buildAgentActivity, persistentAgentRuns, type AgentActivity as AgentActivityModel, type AgentModel } from "../lib/agentActivity.js";
import { emblemForCodename } from "../lib/agentEmblems.js";
import { fallbackCodename } from "../lib/agentNames.js";
import { foldConversationItems } from "../lib/foldConversation.js";
import {
  assistantGroupHasVisibleChat,
  coalesceAssistantGroups,
  lastThinkingGroupId,
  preToolNarrationGroupIds,
  type AssistantGroup
} from "../lib/sessionTurnView.js";
import { buildToolCallGroup, isAgentToolName, type ToolCall, type TurnToolItem } from "../lib/toolCalls.js";
import { collectTurnFileChanges } from "../lib/turnFileChanges.js";
import { foldToolRunsToSummaries, type TurnBodyChild } from "../lib/turnChildren.js";
import { foldTurnToolItems, latestToolCreatedAt } from "../lib/turnToolItems.js";
import type { ToolCallsDisplay } from "../lib/uiPreferences.js";
import { thoughtDurationMs } from "../formatElapsed.js";
import { AgentEmblem } from "./AgentEmblem.js";
import { ChatBubble } from "./ChatBubble.js";
import type { FileChipOpenOptions } from "./FileChip.js";
import { LogBlock } from "./LogBlock.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";
import { ThinkingLabel } from "./ThinkingLabel.js";
import { ThoughtBlock } from "./ThoughtBlock.js";
import { ToolCallGroupBubble } from "./ToolCallGroupBubble.js";
import { ToolCallRow } from "./ToolCallRow.js";
import { TurnChangesCard } from "./TurnChangesCard.js";
import { TurnBlock } from "./TurnBlock.js";


/**
 * The run's masthead: what the agent was asked to do as the title, and one
 * muted line under it with everything that says which agent this is — its
 * codename, its role, and the model it ran on. The tab strip above carries
 * the codename too, but the strip is a list of every open run while this
 * names the one in view, the way an editor's breadcrumb restates the tab.
 */
function AgentHeader({
  title,
  status,
  codename,
  subagentType,
  model,
  phaseKey
}: {
  title: string;
  status: AgentActivityModel["status"];
  codename: string | undefined;
  subagentType: string | null;
  model: AgentModel | null;
  phaseKey: string;
}): JSX.Element {
  // Roles arrive as the identifiers agents are launched with (`implementer`,
  // `general-purpose`); the line reads as prose, so they get a capital.
  const role = subagentType ? subagentType.charAt(0).toUpperCase() + subagentType.slice(1) : null;
  const facts = [codename, role, model?.label, model?.effort].filter(
    (fact): fact is string => typeof fact === "string" && fact.length > 0
  );
  const emblem = emblemForCodename(codename ?? fallbackCodename(phaseKey));
  return (
    <header className="agent-activity-header">
      <span
        className="agent-activity-mark agent-emblem-tint"
        data-status={status}
        data-hue={emblem.hue}
        aria-hidden="true"
      >
        {/* The emblem whatever the run is doing: this mark is the agent's
            identity, sitting above a transcript that already streams and beside
            a tab strip that already carries the status. Even a still nest here
            reads as a second status ticker. */}
        <AgentEmblem
          shape={emblem.shape}
          hue={emblem.hue}
          size={18}
          status={status === "error" ? "error" : "done"}
        />
      </span>
      <div className="agent-activity-heading">
        <h2 className="agent-activity-title" title={title}>{title}</h2>
        {facts.length > 0 ? (
          <p className="agent-activity-facts" aria-label="Agent details">
            {facts.map((fact, index) => (
              <span key={`${index}-${fact}`} className="agent-activity-fact">
                {index > 0 ? <span className="agent-activity-fact-separator" aria-hidden="true">·</span> : null}
                {fact}
              </span>
            ))}
          </p>
        ) : null}
      </div>
    </header>
  );
}


function renderAssistantGroup({
  group,
  thinkingLive,
  thoughtExpanded,
  holdThoughtOpen,
  agentKey,
  workspace,
  onOpenFile,
  restoring
}: {
  group: AssistantGroup;
  thinkingLive: boolean;
  /** Saved thinking default, or the pane chip's explicit override. */
  thoughtExpanded: boolean | undefined;
  holdThoughtOpen: boolean;
  /** Namespaces this pane's group ids, which only count within one agent run. */
  agentKey: string | null;
  workspace: WorkspaceSummary | null;
  onOpenFile?: (path: string, opts?: FileChipOpenOptions) => void;
  restoring?: boolean;
}): JSX.Element | null {
  if (group.thinking) {
    return (
      <ThoughtBlock
        key={group.id}
        defaultExpanded={thoughtExpanded}
        live={thinkingLive}
        // The newest burst never folds in place: the pane follows its own
        // scroll to the bottom, so losing the reasoning's height the moment the
        // answer starts would yank the view up. A burst that a later one has
        // superseded is history and folds. An explicit fold from the pane chip
        // still wins over both.
        holdOpen={holdThoughtOpen}
        durationMs={thoughtDurationMs(group.createdAt, group.lastActivityAt)}
      >
        {/* Same as the chat surface: a live thought streams so the committed
            prefix stops being re-parsed on every reasoning delta. */}
        <StreamingMarkdown
          text={group.text}
          streaming={thinkingLive}
          paced={false}
          workspace={workspace}
          onOpenFile={onOpenFile}
        />
      </ThoughtBlock>
    );
  }
  if (group.error) {
    if (!assistantGroupHasVisibleChat(group)) return null;
    return <LogBlock key={group.id} text={group.text} tone="error" />;
  }
  if (!assistantGroupHasVisibleChat(group)) return null;
  return (
    <ChatBubble key={group.id} kind="assistant" rawMarkdown={group.text}>
      <StreamingMarkdown
        text={group.text}
        streaming={group.streaming}
        restoring={restoring}
        revealKey={agentKey ? `${agentKey}:${group.createdAt}:${group.id}` : null}
        workspace={workspace}
        onOpenFile={onOpenFile}
      />
    </ChatBubble>
  );
}

function AgentResult({
  finalOutput,
  workspace,
  onOpenFile
}: {
  finalOutput: string;
  workspace: WorkspaceSummary | null;
  onOpenFile?: (path: string, opts?: FileChipOpenOptions) => void;
}): JSX.Element {
  return (
    // No eyebrow: the brighter panel, the stronger border, and being last in
    // the pane already say "this is the answer", and subagent output usually
    // opens with its own heading. `aria-label` carries the name instead.
    <section className="agent-activity-final" aria-label="Agent result">
      <StreamingMarkdown
        text={finalOutput}
        streaming={false}
        workspace={workspace}
        onOpenFile={onOpenFile}
      />
    </section>
  );
}

function AgentActivityRun({
  events,
  codename,
  defaultToolCallsDisplay,
  defaultToolCallGroupsExpanded,
  defaultThinkingExpanded,
  isFocused,
  onLoadAgentEvents,
  onLoadSessionEvents,
  onOpenAgent,
  onOpenDiff,
  onOpenFile,
  onOpenReview,
  parentSession,
  parentToolUseId,
  workspace,
  agentRunId = null,
  providerInvocationId = null,
  nativeIdentity = null,
  historyHydrated
}: {
  events: TimelineEvent[];
  codename?: string;
  /** The same chat-verbosity settings the transcript reads, so a subagent's
   *  run is as quiet or as detailed as the chat that launched it. */
  defaultToolCallsDisplay?: ToolCallsDisplay;
  defaultToolCallGroupsExpanded?: boolean;
  defaultThinkingExpanded?: boolean;
  isFocused?: boolean;
  onLoadAgentEvents?: (
    sessionId: string,
    parentToolUseId: string,
    identity?: NativeAgentIdentity
  ) => Promise<void | { hasMore: boolean }>;
  onLoadSessionEvents?: (sessionId: string) => Promise<void>;
  onOpenAgent?: (tool: ToolCall) => void;
  /** Open one file's diff in the review panel's Changes view. */
  onOpenDiff?: (path: string) => void;
  onOpenFile?: (path: string, opts?: FileChipOpenOptions) => void;
  /** Open the review panel on the workspace's changes. */
  onOpenReview?: () => void;
  parentSession: SessionSummary | null;
  parentToolUseId: string;
  workspace: WorkspaceSummary | null;
  agentRunId?: string | null;
  providerInvocationId?: string | null;
  nativeIdentity?: NativeAgentIdentity | null;
  /** Shared readiness for a backfill that can populate every persistent run. */
  historyHydrated?: boolean;
}): JSX.Element {
  const parentSessionId = parentSession?.id ?? null;
  const visibleEvents = useMemo(
    () => parentSessionId ? events.filter((event) => event.sessionId === parentSessionId) : [],
    [events, parentSessionId]
  );
  const activity = useMemo(
    () =>
      buildAgentActivity({
        parentToolUseId,
        agentRunId,
        providerInvocationId,
        nativeIdentity,
        events: visibleEvents,
        sessionRunning: parentSession?.state === "running",
        sessionInterrupted: parentSession?.state === "failed" || parentSession?.state === "cancelled",
        provider: parentSession?.provider
      }),
    [agentRunId, nativeIdentity, parentSession?.provider, parentSession?.state, parentToolUseId, providerInvocationId, visibleEvents]
  );
  const finalOutput = activity.finalOutput;
  // Per-agent state needs no reset when the run changes: the dock mounts one
  // pane per tab, keyed by this id, so an instance only ever shows one agent.
  // Resetting it in an effect instead cost the first click after the pane
  // opened — the mount's passive effects can still be queued when it lands, and
  // they then flush over the click's update.
  const [instructionsExpanded, setInstructionsExpanded] = useState(false);
  const agentKey = parentSessionId
    ? `${parentSessionId}:${parentToolUseId}:${agentRunId ?? "legacy"}`
    : null;
  const [loadedAgentKey, setLoadedAgentKey] = useState<string | null>(null);
  const [failedAgentKey, setFailedAgentKey] = useState<string | null>(null);
  const [loadingAgentKey, setLoadingAgentKey] = useState<string | null>(null);
  const [limitedHistoryKey, setLimitedHistoryKey] = useState<string | null>(null);
  const agentEventsInFlightKeysRef = useRef(new Set<string>());
  const followItems = useMemo(
    () => [...activity.items, finalOutput, activity.status],
    [activity.items, finalOutput, activity.status]
  );
  const streaming = parentSession?.state === "running" && activity.status === "running";
  // A subagent run is one turn, so it plays the part the chat's *latest* turn
  // plays: the pane chip governs the whole run's tools and reasoning at once,
  // and the saved verbosity decides where it starts. Minimal never expands —
  // the run reads as one self-updating line, and a finished one keeps only its
  // result until the chip is opened.
  const minimalActivity = defaultToolCallsDisplay === "single-line";
  const compactActivity = defaultToolCallsDisplay === "collapsed" && defaultToolCallGroupsExpanded !== true;
  const activityExpandedDefault =
    !minimalActivity && (defaultToolCallGroupsExpanded ?? defaultToolCallsDisplay === "expanded");
  const [activityExpandOverride, setActivityExpandOverride] = useState<boolean | null>(null);
  const activityExpanded = activityExpandOverride ?? activityExpandedDefault;
  // `loadedAgentKey` is set in the load's `finally`, so this clears whether the
  // read succeeded or failed — a pane that never settled would keep motion
  // suppressed for good.
  const initialAgentEventsLoadPending = Boolean(
    agentKey && onLoadAgentEvents && loadedAgentKey !== agentKey
  );
  // Restored turns must not replay their entrance animation on every reopen,
  // and the run's trace only arrives once `loadAgentEvents` has answered — so
  // the window runs from there, not from mount. Timed from mount it expired
  // first, and the whole run then animated and typed itself out as if it had
  // just happened.
  const restoringTranscript = useRestoreWithoutMotion(historyHydrated ?? !initialAgentEventsLoadPending);
  const { activityChildren, toolItems, assistantTimestamps } = useMemo((): {
    activityChildren: TurnBodyChild[];
    toolItems: TurnToolItem[];
    assistantTimestamps: number[];
  } => {
    const assistantEvents = activity.items.flatMap((item) =>
      item.kind === "message" ? [item.event] : []
    );
    const tools = activity.items.flatMap((item) => (item.kind === "tool" ? [item.tool] : []));
    // Attach child calls before interleaving individual tools with prose.
    const folded = foldTurnToolItems(
      foldConversationItems([], tools).flatMap((item): TurnToolItem[] =>
        item.kind === "message" ? [] : [item]
      )
    );
    const assistantGroups = coalesceAssistantGroups(assistantEvents, {
      splitAt: tools.map((tool) => tool.createdAt).sort(),
      streaming
    });
    const hasAnswerText = assistantGroups.some(
      (group) => !group.thinking && assistantGroupHasVisibleChat(group)
    );
    const thinkingLive = streaming && !hasAnswerText;
    // Only the run's newest reasoning burst is live: tool boundaries flush a
    // fresh thinking group, so a run that never narrates holds one per call and
    // a turn-wide flag opened every one of them at once. See
    // `lastThinkingGroupId`.
    const liveThoughtGroupId = lastThinkingGroupId(assistantGroups);
    const hiddenNarrationIds = preToolNarrationGroupIds(
      assistantGroups,
      minimalActivity && !streaming && !activityExpanded ? latestToolCreatedAt(folded) : null,
      // The pane renders the run's answer as its own result panel, so there is
      // no last prose group worth keeping to stand in for one.
      { separateAnswer: finalOutput !== null }
    );
    const assistantChildren = assistantGroups.flatMap<TurnBodyChild & { createdAt: string; sortAt: string }>((group) => {
      const groupLive = thinkingLive && group.id === liveThoughtGroupId;
      // Minimal folds settled Thought blocks away entirely — only the live
      // "Thinking" indicator survives.
      if (minimalActivity && group.thinking && !groupLive) return [];
      if (hiddenNarrationIds.has(group.id)) {
        return [{ kind: "assistant" as const, id: `assistant-${group.id}`, createdAt: group.createdAt, sortAt: group.lastActivityAt, node: null }];
      }
      const node = renderAssistantGroup({
        group,
        thinkingLive: groupLive,
        thoughtExpanded: activityExpandOverride ?? defaultThinkingExpanded,
        // Keyed on the group, not on `groupLive`: the hold has to outlast live
        // so the newest block is still open when the answer lands under it.
        holdThoughtOpen: activityExpandOverride !== false && group.id === liveThoughtGroupId,
        agentKey,
        workspace,
        onOpenFile,
        restoring: restoringTranscript
      });
      if (node === null) return [];
      return [
        {
          kind: "assistant" as const,
          id: `assistant-${group.id}`,
          createdAt: group.createdAt,
          sortAt: group.lastActivityAt,
          node
        }
      ];
    });
    const toolChildren: (TurnBodyChild & { createdAt: string; sortAt: string; runTools?: ToolCall[] })[] = folded.map((item) => {
      return {
          kind: "tool" as const,
          id: `tool-${item.tool.id}`,
          createdAt: item.tool.createdAt,
          sortAt: item.tool.createdAt,
          hasErrors: item.tool.status === "error",
          runTools: isAgentToolName(item.tool.name)
            ? compactActivity && item.tool.status !== "error" ? [item.tool] : undefined
            : [item.tool, ...(item.children ?? [])],
          node: (
            <ToolCallRow
              key={item.tool.id}
              tool={item.tool}
              childTools={item.children}
              defaultExpanded={activityExpanded}
              workspaceCwd={workspace?.path ?? null}
              onOpenFile={onOpenFile}
              onOpenAgent={onOpenAgent}
            />
          )
        };
    });
    const sorted = [...assistantChildren, ...toolChildren].sort((a, b) => {
      const cmp = a.sortAt.localeCompare(b.sortAt);
      if (cmp !== 0) return cmp;
      return (a.kind === "assistant" ? -1 : 0) - (b.kind === "assistant" ? -1 : 0);
    });
    const bodySource = foldToolRunsToSummaries(sorted, (runTools) => (
      <ToolCallGroupBubble
        group={buildToolCallGroup(runTools)}
        compact={compactActivity}
        defaultExpanded={!minimalActivity && activityExpanded}
        defaultToolsExpanded={!minimalActivity && (activityExpandOverride ?? defaultToolCallsDisplay === "expanded")}
        workspaceCwd={workspace?.path ?? null}
        onOpenFile={onOpenFile}
        onOpenAgent={onOpenAgent}
      />
    )).filter((child) => child.node !== null);
    return {
      activityChildren: bodySource.map(({ kind, id, node, hasErrors }) => ({ kind, id, node, hasErrors })),
      toolItems: folded,
      assistantTimestamps: assistantEvents
        .map((event) => Date.parse(event.createdAt))
        .filter((ms) => Number.isFinite(ms))
    };
  }, [
    activity.items,
    activityExpandOverride,
    activityExpanded,
    compactActivity,
    defaultToolCallsDisplay,
    agentKey,
    defaultThinkingExpanded,
    finalOutput,
    minimalActivity,
    onOpenAgent,
    onOpenFile,
    restoringTranscript,
    streaming,
    workspace
  ]);
  const {
    conversationListRef,
    showScrollToBottom,
    newBelowCount,
    scrollToBottom,
    handleUserScrollIntent,
    handleScroll
  } = useSmartFollowScroll(
    agentKey,
    followItems,
    false
  );
  const loadAgentEventsGuarded = useCallback(async (): Promise<void> => {
    const loadKey = agentKey;
    if (!parentSessionId || !onLoadAgentEvents || !loadKey || agentEventsInFlightKeysRef.current.has(loadKey)) {
      return;
    }
    agentEventsInFlightKeysRef.current.add(loadKey);
    setLoadingAgentKey(loadKey);
    try {
      const identity = nativeIdentity ?? (activity.parentTool?.providerParentConversationId && activity.parentTool.providerChildSessionId
        ? {
            providerParentConversationId: activity.parentTool.providerParentConversationId,
            providerChildSessionId: activity.parentTool.providerChildSessionId
          }
        : undefined);
      const result = await onLoadAgentEvents(parentSessionId, parentToolUseId, identity);
      setLimitedHistoryKey(result?.hasMore ? loadKey : (currentKey) => currentKey === loadKey ? null : currentKey);
      setFailedAgentKey((currentKey) => (currentKey === loadKey ? null : currentKey));
    } catch {
      setFailedAgentKey(loadKey);
    } finally {
      agentEventsInFlightKeysRef.current.delete(loadKey);
      setLoadedAgentKey(loadKey);
      setLoadingAgentKey((currentKey) => (currentKey === loadKey ? null : currentKey));
    }
  }, [activity.parentTool?.providerChildSessionId, activity.parentTool?.providerParentConversationId, agentKey, nativeIdentity, onLoadAgentEvents, parentSessionId, parentToolUseId]);

  useEffect(() => {
    if (!parentSessionId) return;
    void onLoadSessionEvents?.(parentSessionId);
    void loadAgentEventsGuarded();
  }, [loadAgentEventsGuarded, onLoadSessionEvents, parentSessionId]);

  useEffect(() => {
    if (!parentSessionId || !onLoadAgentEvents) return;
    const shouldPoll = parentSession?.state === "running" || activity.status === "running";
    if (!shouldPoll) return;
    const interval = window.setInterval(() => {
      // A backgrounded window resumes polling on refocus (dashboard deltas
      // keep state fresh meanwhile); skip ticks for invisible windows.
      if (document.hidden) return;
      void loadAgentEventsGuarded();
    }, 1500);
    return () => window.clearInterval(interval);
  }, [activity.status, loadAgentEventsGuarded, onLoadAgentEvents, parentSession?.state, parentSessionId]);

  // The launch is when the run started, so the chip's clock counts from there
  // rather than from the subagent's first visible event.
  const launchedAtMs = useMemo(() => {
    const ms = Date.parse(activity.parentTool?.createdAt ?? "");
    return Number.isFinite(ms) ? ms : null;
  }, [activity.parentTool?.createdAt]);
  // Minimal collapses the whole body away, so a run with tools but no visible
  // child is still a rendered run, not a pane still waiting for one.
  const hasRenderedActivity =
    activityChildren.length > 0 || toolItems.length > 0 || finalOutput !== null;
  const waitingForRunningAgentActivity = Boolean(
    (parentSession?.state === "running" || activity.status === "running") &&
    activity.limited
  );
  const showAgentActivityThinking = (
    (loadingAgentKey === agentKey || initialAgentEventsLoadPending || waitingForRunningAgentActivity) &&
    !hasRenderedActivity
  );
  const showLimitedNotice = activity.limited && !showAgentActivityThinking;
  const showLoadFailureNotice = failedAgentKey === agentKey && !showAgentActivityThinking;
  const runChanges = useMemo(() => collectTurnFileChanges(toolItems), [toolItems]);

  return (
    <section
      className="agent-activity"
      aria-label={codename ? `Agent activity: ${codename} — ${activity.title}` : `Agent activity: ${activity.title}`}
      data-focused={isFocused ? "true" : undefined}
    >
      <AgentHeader
        title={activity.title}
        status={activity.status}
        codename={codename}
        subagentType={activity.subagentType}
        model={activity.model}
        phaseKey={parentToolUseId}
      />
      <div
        className="agent-activity-scroll"
        data-restoring={restoringTranscript ? "true" : undefined}
        ref={conversationListRef}
        onScroll={handleScroll}
        onWheel={handleUserScrollIntent}
        onTouchMove={handleUserScrollIntent}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) {
            handleUserScrollIntent();
          }
        }}
        onPointerMove={(event) => {
          if (event.buttons !== 0) {
            handleUserScrollIntent();
          }
        }}
        onKeyDown={(event) => {
          // Unlike pointerdown, a scroll key is intent wherever focus sits:
          // the browser scrolls this list for any descendant control.
          if (SCROLL_INTENT_KEYS.has(event.key)) {
            handleUserScrollIntent();
          }
        }}
      >
        {activity.prompt ? (
          // The brief folds behind the same chip the run's activity uses, so
          // the pane opens on two quiet lines — Instructions, Worked for — and
          // the header above already says what the agent was asked to do.
          <section className="agent-activity-summary" aria-label="Agent instructions">
            <div className="turn-block-header">
              <button
                type="button"
                className="turn-block-chip"
                aria-label={instructionsExpanded ? "Collapse instructions" : "Expand instructions"}
                title={instructionsExpanded ? "Collapse instructions" : "Expand instructions"}
                aria-expanded={instructionsExpanded}
                onClick={() => setInstructionsExpanded((expanded) => !expanded)}
              >
                <span>Instructions</span>
                <ChevronRight
                  size={11}
                  className={`turn-block-chevron${instructionsExpanded ? " expanded" : ""}`}
                  aria-hidden="true"
                />
              </button>
            </div>
            {instructionsExpanded ? (
              <div className="agent-activity-prompt">
                <StreamingMarkdown
                  text={activity.prompt}
                  streaming={false}
                  workspace={workspace}
                  onOpenFile={onOpenFile}
                />
              </div>
            ) : null}
          </section>
        ) : null}

        {showAgentActivityThinking ? (
          <div className="agent-activity-empty" role="status">
            <ThinkingLabel phaseKey={parentToolUseId} startedAtMs={launchedAtMs ?? undefined} />
          </div>
        ) : null}

        {showLoadFailureNotice ? (
          <div className="agent-activity-empty" role="alert">
            Agent activity could not be loaded. Showing launch/result metadata.
          </div>
        ) : showLimitedNotice ? (
          <div className="agent-activity-empty" role="status">
            This provider reported the agent launch, but did not stream child activity.
          </div>
        ) : null}

        {limitedHistoryKey === agentKey ? (
          <div className="agent-activity-empty" role="status">
            Earlier agent activity is not shown.
          </div>
        ) : null}

        {activityChildren.length > 0 || toolItems.length > 0 ? (
          // The same block the transcript wraps a turn in, so the run carries
          // the same "Worked for Xs" chip: one control over every tool group
          // and Thought block below it.
          <TurnBlock
            toolItems={toolItems}
            assistantTimestamps={assistantTimestamps}
            {...(launchedAtMs !== null ? { turnStartedAtMs: launchedAtMs } : {})}
            isTurnActive={streaming}
            toolsExpanded={activityExpanded}
            onToggleTools={() => setActivityExpandOverride(!activityExpanded)}
            hideWorkingWhenCollapsed={minimalActivity}
            body={activityChildren}
          />
        ) : !showLimitedNotice && !showAgentActivityThinking ? (
          <div className="agent-activity-empty" role="status">
            Waiting for agent activity.
          </div>
        ) : null}

        {finalOutput !== null ? (
          <AgentResult
            finalOutput={finalOutput}
            workspace={workspace}
            onOpenFile={onOpenFile}
          />
        ) : null}
        {!streaming && runChanges.length > 0 ? (
          <TurnChangesCard
            changes={runChanges}
            workspaceCwd={workspace?.path ?? null}
            {...(onOpenDiff ? { onOpenDiff } : {})}
            {...(onOpenFile ? { onOpenFile } : {})}
            {...(onOpenReview ? { onOpenReview } : {})}
          />
        ) : null}
        {showScrollToBottom ? (
          <button
            type="button"
            className="scroll-to-bottom-fab"
            aria-label={newBelowCount > 0 ? `Scroll to latest (${newBelowCount} new)` : "Scroll to latest"}
            title={newBelowCount > 0 ? `Scroll to latest (${newBelowCount} new)` : "Scroll to latest"}
            onClick={scrollToBottom}
          >
            <ArrowDown size={19} strokeWidth={2.2} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function AgentActivity(props: Parameters<typeof AgentActivityRun>[0]): JSX.Element {
  const [historyHydrated, setHistoryHydrated] = useState(!props.onLoadAgentEvents);
  const loadAgentEvents = useCallback<NonNullable<typeof props.onLoadAgentEvents>>(async (...args) => {
    try {
      return await props.onLoadAgentEvents?.(...args);
    } finally {
      setHistoryHydrated(true);
    }
  }, [props.onLoadAgentEvents]);
  const onLoadAgentEvents = props.onLoadAgentEvents ? loadAgentEvents : undefined;
  const parentSessionId = props.parentSession?.id ?? null;
  const visibleEvents = parentSessionId
    ? props.events.filter((event) => event.sessionId === parentSessionId)
    : [];
  const runs = persistentAgentRuns(visibleEvents, props.parentToolUseId, props.nativeIdentity ?? null);
  if (runs.length <= 1) {
    return (
      <AgentActivityRun
        {...props}
        agentRunId={runs[0]?.agentRunId ?? null}
        providerInvocationId={runs[0]?.providerInvocationId ?? null}
        onLoadAgentEvents={onLoadAgentEvents}
        historyHydrated={historyHydrated}
      />
    );
  }
  return (
    <div className="agent-activity-history" aria-label={`Agent runs: ${props.codename ?? props.parentToolUseId}`}>
      {runs.map((run, index) => (
        <AgentActivityRun
          key={run.key}
          {...props}
          agentRunId={run.agentRunId}
          providerInvocationId={run.providerInvocationId}
          onLoadAgentEvents={index === runs.length - 1 ? onLoadAgentEvents : undefined}
          onLoadSessionEvents={index === runs.length - 1 ? props.onLoadSessionEvents : undefined}
          historyHydrated={historyHydrated}
        />
      ))}
    </div>
  );
}
