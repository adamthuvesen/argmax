import { ArrowDown, ChevronDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import type { SessionSummary, TimelineEvent, WorkspaceSummary } from "../../shared/types.js";
import { useRestoreWithoutMotion } from "../hooks/useRestoreWithoutMotion.js";
import { SCROLL_INTENT_KEYS, useSmartFollowScroll } from "../hooks/useSmartFollowScroll.js";
import { buildAgentActivity } from "../lib/agentActivity.js";
import { foldConversationItems } from "../lib/foldConversation.js";
import {
  assistantGroupHasVisibleChat,
  coalesceAssistantGroups,
  preToolNarrationGroupIds,
  type AssistantGroup
} from "../lib/sessionTurnView.js";
import type { ToolCall, TurnToolItem } from "../lib/toolCalls.js";
import { collectTurnFileChanges } from "../lib/turnFileChanges.js";
import { foldToolRunsToSummaries, type TurnBodyChild } from "../lib/turnChildren.js";
import { foldTurnToolItems, latestToolCreatedAt } from "../lib/turnToolItems.js";
import type { ToolCallsDisplay } from "../lib/uiPreferences.js";
import { thoughtDurationMs } from "../formatElapsed.js";
import { ActivitySummaryLine } from "./ActivitySummaryLine.js";
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

const PROMPT_COLLAPSE_THRESHOLD = 560;

function isLongPrompt(prompt: string | null): boolean {
  if (!prompt) return false;
  return prompt.length > PROMPT_COLLAPSE_THRESHOLD || prompt.split("\n").length > 8;
}


function renderAssistantGroup({
  group,
  thinkingLive,
  thoughtExpanded,
  holdThoughtOpen,
  agentKey,
  workspace,
  onOpenFile
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
}): JSX.Element | null {
  if (group.thinking) {
    return (
      <ThoughtBlock
        key={group.id}
        defaultExpanded={thoughtExpanded}
        live={thinkingLive}
        // Never fold in place: the pane follows its own scroll to the bottom,
        // so losing the reasoning's height the moment the answer starts would
        // yank the view up. An explicit fold from the pane chip still wins.
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

export function AgentActivity({
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
  workspace
}: {
  events: TimelineEvent[];
  codename?: string;
  /** The same chat-verbosity settings the transcript reads, so a subagent's
   *  run is as quiet or as detailed as the chat that launched it. */
  defaultToolCallsDisplay?: ToolCallsDisplay;
  defaultToolCallGroupsExpanded?: boolean;
  defaultThinkingExpanded?: boolean;
  isFocused?: boolean;
  onLoadAgentEvents?: (sessionId: string, parentToolUseId: string) => Promise<void>;
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
        events: visibleEvents,
        sessionRunning: parentSession?.state === "running",
        provider: parentSession?.provider
      }),
    [parentSession?.provider, parentSession?.state, parentToolUseId, visibleEvents]
  );
  const promptIsLong = isLongPrompt(activity.prompt);
  const finalOutput = activity.finalOutput;
  const [instructionsExpanded, setInstructionsExpanded] = useState(false);
  const agentKey = parentSessionId ? `${parentSessionId}:${parentToolUseId}` : null;
  const [loadedAgentKey, setLoadedAgentKey] = useState<string | null>(null);
  const [failedAgentKey, setFailedAgentKey] = useState<string | null>(null);
  const [loadingAgentKey, setLoadingAgentKey] = useState<string | null>(null);
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
  const activityExpandedDefault =
    !minimalActivity && (defaultToolCallGroupsExpanded ?? defaultToolCallsDisplay === "expanded");
  const [activityExpandOverride, setActivityExpandOverride] = useState<boolean | null>(null);
  const activityExpanded = activityExpandOverride ?? activityExpandedDefault;
  const { activityChildren, toolItems, assistantTimestamps } = useMemo((): {
    activityChildren: TurnBodyChild[];
    toolItems: TurnToolItem[];
    assistantTimestamps: number[];
  } => {
    const assistantEvents = activity.items.flatMap((item) =>
      item.kind === "message" ? [item.event] : []
    );
    const tools = activity.items.flatMap((item) => (item.kind === "tool" ? [item.tool] : []));
    // Same two folds the transcript runs: consecutive calls become one group
    // row, then bash-like runs merge and a subagent's own children nest under
    // the launch that spawned them.
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
    const hiddenNarrationIds = preToolNarrationGroupIds(
      assistantGroups,
      minimalActivity && !streaming && !activityExpanded ? latestToolCreatedAt(folded) : null,
      // The pane renders the run's answer as its own result panel, so there is
      // no last prose group worth keeping to stand in for one.
      { separateAnswer: finalOutput !== null }
    );
    const assistantChildren = assistantGroups.flatMap((group) => {
      // Minimal folds settled Thought blocks away entirely — only the live
      // "Thinking" indicator survives.
      if (minimalActivity && group.thinking && !thinkingLive) return [];
      if (hiddenNarrationIds.has(group.id)) return [];
      const node = renderAssistantGroup({
        group,
        thinkingLive,
        thoughtExpanded: activityExpandOverride ?? defaultThinkingExpanded,
        holdThoughtOpen: activityExpandOverride !== false,
        agentKey,
        workspace,
        onOpenFile
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
    const toolChildren = folded.map((item) => {
      if (item.kind === "tool") {
        return {
          kind: "tool" as const,
          id: `tool-${item.tool.id}`,
          createdAt: item.tool.createdAt,
          sortAt: item.tool.createdAt,
          runTools: [item.tool, ...(item.children ?? [])],
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
      }
      const firstCreatedAt = item.group.tools[0]?.createdAt ?? "";
      return {
        kind: "tool" as const,
        id: `tool-${item.group.id}`,
        createdAt: firstCreatedAt,
        sortAt: firstCreatedAt,
        runTools: item.group.tools,
        node: (
          <ToolCallGroupBubble
            key={item.group.id}
            group={item.group}
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
    const bodySource = minimalActivity
      ? foldToolRunsToSummaries(sorted, (runTools) =>
          // A run of one is not a summary: the line and the row it would hide
          // are the same sentence, so show the row.
          runTools.length === 1 && runTools[0] ? (
            <ToolCallRow
              tool={runTools[0]}
              workspaceCwd={workspace?.path ?? null}
              onOpenFile={onOpenFile}
              onOpenAgent={onOpenAgent}
            />
          ) : (
            <ActivitySummaryLine
              tools={runTools}
              workspaceCwd={workspace?.path ?? null}
              onOpenFile={onOpenFile}
              onOpenAgent={onOpenAgent}
            />
          )
        )
      : sorted;
    return {
      activityChildren: bodySource.map(({ kind, id, node }) => ({ kind, id, node })),
      toolItems: folded,
      assistantTimestamps: assistantEvents
        .map((event) => Date.parse(event.createdAt))
        .filter((ms) => Number.isFinite(ms))
    };
  }, [
    activity.items,
    activityExpandOverride,
    activityExpanded,
    agentKey,
    defaultThinkingExpanded,
    finalOutput,
    minimalActivity,
    onOpenAgent,
    onOpenFile,
    streaming,
    workspace
  ]);
  // Restored turns must not replay their entrance animation on every reopen.
  const restoringTranscript = useRestoreWithoutMotion();
  const {
    conversationListRef,
    showScrollToBottom,
    newBelowCount,
    scrollToBottom,
    handleUserScrollIntent,
    handleScroll
  } = useSmartFollowScroll(
    parentSessionId ? `${parentSessionId}:${parentToolUseId}` : null,
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
      await onLoadAgentEvents(parentSessionId, parentToolUseId);
      setFailedAgentKey((currentKey) => (currentKey === loadKey ? null : currentKey));
    } catch {
      setFailedAgentKey(loadKey);
    } finally {
      agentEventsInFlightKeysRef.current.delete(loadKey);
      setLoadedAgentKey(loadKey);
      setLoadingAgentKey((currentKey) => (currentKey === loadKey ? null : currentKey));
    }
  }, [agentKey, onLoadAgentEvents, parentSessionId, parentToolUseId]);

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
      void loadAgentEventsGuarded();
    }, 1500);
    return () => window.clearInterval(interval);
  }, [activity.status, loadAgentEventsGuarded, onLoadAgentEvents, parentSession?.state, parentSessionId]);

  useEffect(() => {
    setInstructionsExpanded(false);
    setActivityExpandOverride(null);
  }, [parentToolUseId]);

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
  const initialAgentEventsLoadPending = Boolean(
    agentKey && onLoadAgentEvents && loadedAgentKey !== agentKey
  );
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
        {activity.prompt || activity.subagentType || activity.model ? (
          <section className="agent-activity-summary" aria-label="Agent instructions">
            <div className="agent-activity-summary-header">
              {/* One eyebrow: who this is, and what it runs on, said once and
                  where the run is described. Whether it is still working is the
                  tab's mark. */}
              <p className="agent-activity-meta agent-activity-summary-label">
                {[activity.subagentType ?? "Instructions", activity.model?.label]
                  .filter(Boolean)
                  .join(" · ")}
                {activity.model?.effort ? (
                  <span className="agent-activity-effort"> · {activity.model.effort}</span>
                ) : null}
              </p>
              {promptIsLong ? (
                <button
                  type="button"
                  className="small-icon agent-activity-summary-toggle"
                  aria-label={instructionsExpanded ? "Collapse instructions" : "Expand instructions"}
                  title={instructionsExpanded ? "Collapse instructions" : "Expand instructions"}
                  aria-expanded={instructionsExpanded}
                  onClick={() => setInstructionsExpanded((expanded) => !expanded)}
                >
                  <ChevronDown size={14} aria-hidden="true" />
                </button>
              ) : null}
            </div>
            {activity.prompt ? (
              <div
                className="agent-activity-prompt"
                data-collapsible={promptIsLong ? "true" : undefined}
                data-expanded={instructionsExpanded ? "true" : undefined}
              >
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
            <ThinkingLabel phaseKey={parentToolUseId} />
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
