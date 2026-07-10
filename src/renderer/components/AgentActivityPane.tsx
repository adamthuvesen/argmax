import { ArrowDown, Bot, ChevronDown, Loader2, X } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import type { SessionSummary, TimelineEvent, WorkspaceSummary } from "../../shared/types.js";
import { useSmartFollowScroll } from "../hooks/useSmartFollowScroll.js";
import { buildAgentActivity } from "../lib/agentActivity.js";
import { coalesceAssistantGroups, type AssistantGroup } from "../lib/sessionTurnView.js";
import type { ToolCall } from "../lib/toolCalls.js";
import { ChatBubble } from "./ChatBubble.js";
import type { FileChipOpenOptions } from "./FileChip.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";
import { ThinkingLabel } from "./ThinkingLabel.js";
import { ThoughtBlock } from "./ThoughtBlock.js";
import { ToolCallRow } from "./ToolCallRow.js";

function statusLabel(status: "running" | "done" | "error" | "missing"): string {
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

const PROMPT_COLLAPSE_THRESHOLD = 560;

function isLongPrompt(prompt: string | null): boolean {
  if (!prompt) return false;
  return prompt.length > PROMPT_COLLAPSE_THRESHOLD || prompt.split("\n").length > 8;
}

type ActivityRenderChild = {
  kind: "assistant" | "tool";
  id: string;
  node: ReactNode;
};

function renderActivityChildren(children: ActivityRenderChild[]): ReactNode {
  const fragments: ReactNode[] = [];
  let toolRun: ActivityRenderChild[] = [];
  const flushTools = (): void => {
    const first = toolRun[0];
    if (!first) return;
    fragments.push(
      <div key={`tools-${first.id}`} className="turn-block-tools">
        {toolRun.map((child) => (
          <Fragment key={child.id}>{child.node}</Fragment>
        ))}
      </div>
    );
    toolRun = [];
  };
  for (const child of children) {
    if (child.kind === "tool") {
      toolRun.push(child);
    } else {
      flushTools();
      fragments.push(<Fragment key={child.id}>{child.node}</Fragment>);
    }
  }
  flushTools();
  return fragments;
}

function renderAssistantGroup({
  group,
  thinkingLive,
  workspace,
  onOpenFile
}: {
  group: AssistantGroup;
  thinkingLive: boolean;
  workspace: WorkspaceSummary | null;
  onOpenFile?: (path: string, opts?: FileChipOpenOptions) => void;
}): JSX.Element {
  if (group.thinking) {
    return (
      <ThoughtBlock key={group.id} defaultExpanded={thinkingLive} live={thinkingLive}>
        <StreamingMarkdown
          text={group.text}
          streaming={false}
          workspace={workspace}
          onOpenFile={onOpenFile}
        />
      </ThoughtBlock>
    );
  }
  return (
    <ChatBubble key={group.id} kind="assistant" rawMarkdown={group.text}>
      <StreamingMarkdown
        text={group.text}
        streaming={group.streaming}
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
    <section className="agent-activity-final" aria-label="Agent result">
      <p className="agent-activity-meta">Result</p>
      <StreamingMarkdown
        text={finalOutput}
        streaming={false}
        workspace={workspace}
        onOpenFile={onOpenFile}
      />
    </section>
  );
}

export function AgentActivityPane({
  events,
  isFocused,
  onClose,
  onLoadAgentEvents,
  onLoadSessionEvents,
  onOpenAgent,
  onOpenFile,
  parentSession,
  parentToolUseId,
  workspace
}: {
  events: TimelineEvent[];
  isFocused?: boolean;
  onClose?: () => void;
  onLoadAgentEvents?: (sessionId: string, parentToolUseId: string) => Promise<void>;
  onLoadSessionEvents?: (sessionId: string) => Promise<void>;
  onOpenAgent?: (tool: ToolCall) => void;
  onOpenFile?: (path: string, opts?: FileChipOpenOptions) => void;
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
        sessionRunning: parentSession?.state === "running"
      }),
    [parentSession?.state, parentToolUseId, visibleEvents]
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
  const activityChildren = useMemo((): ActivityRenderChild[] => {
    const assistantEvents = activity.items.flatMap((item) =>
      item.kind === "message" ? [item.event] : []
    );
    const toolItems = activity.items.flatMap((item) =>
      item.kind === "tool" ? [item.tool] : []
    );
    const assistantGroups = coalesceAssistantGroups(assistantEvents, {
      splitAt: toolItems.map((tool) => tool.createdAt).sort(),
      streaming
    });
    const hasAnswerText = assistantGroups.some(
      (group) => !group.thinking && group.text.trim().length > 0
    );
    const thinkingLive = streaming && !hasAnswerText;
    const assistantChildren = assistantGroups.map((group) => ({
      kind: "assistant" as const,
      id: `assistant-${group.id}`,
      createdAt: group.createdAt,
      sortAt: group.lastActivityAt,
      node: renderAssistantGroup({
        group,
        thinkingLive,
        workspace,
        onOpenFile
      })
    }));
    const toolChildren = toolItems.map((tool) => ({
      kind: "tool" as const,
      id: `tool-${tool.id}`,
      createdAt: tool.createdAt,
      sortAt: tool.createdAt,
      node: (
        <ToolCallRow
          key={tool.id}
          tool={tool}
          defaultExpanded={false}
          workspaceCwd={workspace?.path ?? null}
          onOpenFile={onOpenFile}
          onOpenAgent={onOpenAgent}
        />
      )
    }));
    return [...assistantChildren, ...toolChildren]
      .sort((a, b) => {
        const cmp = a.sortAt.localeCompare(b.sortAt);
        if (cmp !== 0) return cmp;
        return (a.kind === "assistant" ? -1 : 0) - (b.kind === "assistant" ? -1 : 0);
      })
      .map(({ kind, id, node }) => ({ kind, id, node }));
  }, [activity.items, onOpenAgent, onOpenFile, streaming, workspace]);
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
    false,
    streaming
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
  }, [parentToolUseId]);

  const hasRenderedActivity = activityChildren.length > 0 || finalOutput !== null;
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

  return (
    <section className="agent-activity-pane" aria-label={`Agent activity: ${activity.title}`} data-focused={isFocused ? "true" : undefined}>
      <header className="agent-activity-header" data-window-drag>
        <div className="agent-activity-title">
          <Bot size={15} aria-hidden="true" />
          <p className="agent-activity-kicker">Subagent</p>
        </div>
        <div className="agent-activity-actions">
          <span className="agent-activity-status" data-status={activity.status}>
            {activity.status === "running" ? <Loader2 size={12} className="tool-call-spinner" aria-hidden="true" /> : null}
            {statusLabel(activity.status)}
          </span>
          {onClose ? (
            <button type="button" className="small-icon session-pane-close" aria-label="Close pane" onClick={onClose}>
              <X size={14} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </header>

      <div
        className="agent-activity-scroll"
        ref={conversationListRef}
        onScroll={handleScroll}
        onWheel={handleUserScrollIntent}
        onTouchMove={handleUserScrollIntent}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) {
            handleUserScrollIntent();
          }
        }}
      >
        {activity.prompt || activity.subagentType ? (
          <section className="agent-activity-summary" aria-label="Agent instructions">
            <div className="agent-activity-summary-header">
              {activity.subagentType ? (
                <p className="agent-activity-meta">{activity.subagentType}</p>
              ) : (
                <p className="agent-activity-meta">Instructions</p>
              )}
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
            <ThinkingLabel />
          </div>
        ) : null}

        {showLoadFailureNotice ? (
          <div className="agent-activity-empty" role="status">
            Agent activity could not be loaded. Showing launch/result metadata.
          </div>
        ) : showLimitedNotice ? (
          <div className="agent-activity-empty" role="status">
            This provider reported the agent launch, but did not stream child activity.
          </div>
        ) : null}

        {activityChildren.length > 0 ? (
          <div className="agent-activity-items turn-block-body">
            {renderActivityChildren(activityChildren)}
          </div>
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
