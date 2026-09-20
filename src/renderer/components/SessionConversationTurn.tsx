import { Fragment, memo, useMemo, useState, type JSX, type ReactNode } from "react";
import { CornerDownRight } from "lucide-react";
import { attachmentProtocolUrl } from "../../shared/attachmentProtocol.js";
import { FORK_CAPABLE_PROVIDERS } from "../../shared/providerModels.js";
import { splitLinkSegments } from "../lib/messageLinks.js";
import { splitSkillTokens } from "../lib/slashHighlight.js";
import { ImageLightbox } from "./ImageLightbox.js";
import type { SessionSummary, WorkspaceSummary } from "../../shared/types.js";
import type { RenderItem } from "../lib/foldConversation.js";
import { isSupportedImageMime } from "../lib/composerAttachments.js";
import {
  assistantGroupHasVisibleChat,
  buildTurnRenderState,
  lastThinkingGroupId,
  liveThoughtOwnsProgress,
  preToolNarrationGroupIds
} from "../lib/sessionTurnView.js";
import {
  foldActivityRunsToSummaries,
  foldToolRunsToSummaries,
  type ActivityRun
} from "../lib/turnChildren.js";
import { buildToolCallGroup, isAgentToolName, type ToolCall, type TurnToolItem } from "../lib/toolCalls.js";
import type { TodoList } from "../lib/todoList.js";
import type { ThinkingDisplay, ToolCallsDisplay } from "../lib/uiPreferences.js";
import { codenameForTool } from "../lib/agentNames.js";
import { latestToolCreatedAt, visibleTurnToolItem } from "../lib/turnToolItems.js";
import { collectTurnFileChanges } from "../lib/turnFileChanges.js";
import { thoughtDurationMs } from "../formatElapsed.js";
import { AgentLaunchList } from "./AgentLaunchList.js";
import { ChatBubble } from "./ChatBubble.js";
import { LogBlock } from "./LogBlock.js";
import { TodoCard } from "./TodoCard.js";
import { ThoughtBlock } from "./ThoughtBlock.js";
import { ToolCallGroupBubble } from "./ToolCallGroupBubble.js";
import { ToolCallRow } from "./ToolCallRow.js";
import { TurnChangesCard } from "./TurnChangesCard.js";
import { TurnBlock, type TurnBodyChild } from "./TurnBlock.js";
import { TurnRevert } from "./TurnRevert.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";
import { WebLink } from "./WebLink.js";
import {
  parseUserMessageAttachments,
  type UserMessageAttachment
} from "./sessionConversationHelpers.js";
import type { FileChipOpenOptions } from "./FileChip.js";
import type { TranscriptFollow } from "../hooks/useConversationScroll.js";
import { useStableTailWindow } from "../hooks/useStableTailWindow.js";

type TurnRenderItem = Extract<RenderItem, { kind: "turn" }>;

// The conversation-level window counts turns. A provider can keep one turn
// open for hours, so that outer bound alone does not bound the DOM. Keep each
// turn's rendered body small as well. Explicit reveals may grow it by design.
const TURN_BODY_WINDOW = 16;
const TURN_BODY_WINDOW_STEP = 32;

function SessionConversationTurnInner({
  item,
  priorItem,
  isLatestTurn,
  openRunAt = null,
  session,
  workspace,
  agentCodenames,
  onOpenFile,
  onOpenAgent,
  onOpenDiff,
  onOpenReview,
  onForkSession,
  revertCheckpointIds,
  revertCheckpointUnavailable,
  onReverted,
  defaultToolCallsDisplay,
  defaultToolCallGroupsExpanded,
  thinkingDisplay,
  defaultTurnChangesExpanded,
  follow,
  restoringTranscript = false,
  todo = null
}: {
  item: TurnRenderItem;
  priorItem: RenderItem | null;
  isLatestTurn: boolean;
  /** `session.streaming` timestamp when nothing has closed that run yet. */
  openRunAt?: string | null;
  session: SessionSummary | null;
  workspace: WorkspaceSummary | null;
  agentCodenames?: Map<string, string>;
  onOpenFile?: (path: string, opts?: FileChipOpenOptions) => void;
  onOpenAgent?: (tool: ToolCall) => void;
  /** Open one file's diff in the review panel's Changes view. */
  onOpenDiff?: (path: string) => void;
  /** Open the review panel on the workspace's changes, from the top. */
  onOpenReview?: () => void;
  onForkSession?: (sessionId: string) => Promise<void>;
  /** Before-turn checkpoint id, keyed by the user-message event it answers. */
  revertCheckpointIds?: ReadonlyMap<string, string>;
  /** Why Revert is unavailable, keyed by the same user-message event id. */
  revertCheckpointUnavailable?: ReadonlyMap<string, string>;
  onReverted?: () => void;
  defaultToolCallsDisplay?: ToolCallsDisplay;
  defaultToolCallGroupsExpanded?: boolean;
  thinkingDisplay?: ThinkingDisplay;
  defaultTurnChangesExpanded?: boolean;
  /** Freezes this turn's mounted row ids while the reader is away from latest. */
  follow?: TranscriptFollow;
  restoringTranscript?: boolean;
  /** The agent's plan as it stood when this turn ended, or null if it never
   *  touched one. */
  todo?: TodoList | null;
}): JSX.Element {
  // A turn is live when the session row says so — or when this session's
  // transcript is ahead of that row and still inside an open provider run.
  // Session state reaches a client through a `dashboard:list` round trip
  // (deltas carry no session rows), while transcript events arrive on their
  // own revision feed, so a phone routinely holds a row from before the turn
  // began while the turn's edits stream in. That stale row used to settle the
  // whole turn mid-work and post every file it had written as a Changed-files
  // card. Comparing against the row's own clock keeps the row authoritative
  // whenever it is the newer of the two, so a run that died without a closing
  // marker cannot tick forever.
  const transcriptIsAheadOfRow =
    isLatestTurn && openRunAt !== null && openRunAt > (session?.lastActivityAt ?? "");
  const sessionIsLive = session?.state === "running" || transcriptIsAheadOfRow;
  const isStreamingTurn = isLatestTurn && sessionIsLive;
  // Memoized because the state it returns is the input to everything below:
  // `hiddenToolIds` is a fresh Set per call, and it is the only dep of
  // `visibleToolItems`, which is the only dep of `turnChanges`. Re-deriving it
  // in the render body missed both of those memos on every streaming delta, so
  // each mounted turn re-ran `coalesceAssistantGroups` and a diff parse per
  // Edit tool for every chunk that arrived anywhere in the session.
  const turnView = useMemo(
    () =>
      buildTurnRenderState({
        assistantEvents: item.assistantEvents,
        assistantHardSplitAt: item.steerEvents.map((event) => event.createdAt),
        toolItems: item.toolItems,
        priorItem,
        assistantTimestamps: item.assistantTimestamps,
        isStreamingTurn
      }),
    [
      item.assistantEvents,
      item.steerEvents,
      item.toolItems,
      priorItem,
      item.assistantTimestamps,
      isStreamingTurn
    ]
  );
  const { visibleAssistantGroups, hiddenToolIds, turnStartedAtMs, isPausedOnUserInput } = turnView;
  // A Thought block is "live" (shown expanded, labelled "Thinking", in place of
  // the generic indicator) while it is the newest thing this working turn has
  // produced (see liveThoughtOwnsProgress). Once anything follows it the label
  // settles, but
  // the body stays open (`holdOpen`) for as long as this is the newest turn:
  // folding it right then would drop the whole reasoning out of a transcript
  // pinned to the bottom at the exact moment the answer starts arriving. An
  // explicit fold from the turn chip still wins in Compact. Steps previews
  // only live reasoning. Detailed keeps labelled thoughts inline.
  //
  // The beat belongs to the turn's newest reasoning burst, never to every burst
  // in it: tool boundaries flush a fresh thinking group, so this flag read
  // turn-wide expanded all of them at once. `holdOpen` is gated on the same
  // group, because a block that opened while live holds itself open afterwards
  // (`openedLive`) — held turn-wide, every superseded block stays expanded and
  // narrowing `live` alone changes nothing.
  const thinkingLive = liveThoughtOwnsProgress({
    assistantEvents: item.assistantEvents,
    toolItems: item.toolItems,
    isLatestTurn,
    sessionRunning: sessionIsLive,
    isPausedOnUserInput
  });
  const liveThoughtGroupId = lastThinkingGroupId(visibleAssistantGroups);
  // Tool groups expand by default for the current turn (you're watching it
  // work, and it stays open through completion so nothing collapses out from
  // under the answer) and collapse to headers for older turns. The turn chip
  // toggles this for the whole turn; collapsing folds the tool groups to their
  // headers and any collapsible Thought blocks. Inline thoughts stay visible.
  // A per-row chevron still overrides an individual group or the
  // Thought block. "Tool call groups" still wins over "Tool calls in chat" when
  // it is set, so groups can open while the tool rows stay collapsed.
  // Single-line (Minimal) never expands groups: tool runs render as one
  // self-updating line while the turn is live, then the finished turn hides
  // those working rows behind the chip so only the answer remains.
  const minimalActivity = defaultToolCallsDisplay === "single-line";
  const compactThinkingDisplay = thinkingDisplay ?? "collapsed";
  const compactToolSummaries =
    defaultToolCallsDisplay === "collapsed" &&
    defaultToolCallGroupsExpanded !== true;
  const compactActivity = compactToolSummaries && compactThinkingDisplay === "collapsed";
  const toolsExpandedDefault =
    isLatestTurn && !minimalActivity
      ? (defaultToolCallGroupsExpanded ?? defaultToolCallsDisplay === "expanded")
      : false;
  const [toolsExpandOverride, setToolsExpandOverride] = useState<boolean | null>(null);
  const toolsExpanded = toolsExpandOverride ?? toolsExpandedDefault;
  // Detailed opens individual rows as well as groups. An agent
  // launch row follows that rather than the group level, because what its
  // chevron reveals is the raw launch receipt — at Steps the row names the
  // delegated work and the subagent's pane holds the rest.
  const toolRowsExpanded =
    !minimalActivity && (toolsExpandOverride ?? (isLatestTurn && defaultToolCallsDisplay === "expanded"));
  // `createdAt` anchors the turn-start header timestamp; `sortAt` orders the
  // body. Assistant groups order by their LAST activity (see AssistantGroup.
  // lastActivityAt) so a streamed answer settles below the tools it follows
  // instead of floating above them.
  type AnnotatedChild = TurnBodyChild & {
    createdAt: string;
    sortAt: string;
    agentTools?: ToolCall[];
    // Flat tool list this child contributes to an activity group.
    runTools?: ToolCall[];
    sortPriority?: number;
  };
  const lastToolCreatedAt = latestToolCreatedAt(item.toolItems);
  // Finished Minimal keeps the answer: assistant text after the last tool.
  // Claude, Codex, Grok, and OpenCode write progress as `message.completed`
  // before each tool. Expanding the chip restores the narration with the
  // tools. Live turns keep it so the user can watch the agent talk while tools
  // run.
  // `isStreamingTurn` is this turn's own liveness, not the session's: keying
  // off `sessionIsLive` alone re-expanded every finished turn the moment a new
  // turn started.
  const hiddenNarrationIds = preToolNarrationGroupIds(
    visibleAssistantGroups,
    minimalActivity && !isStreamingTurn && !toolsExpanded ? lastToolCreatedAt : null
  );
  const assistantChildren: AnnotatedChild[] = visibleAssistantGroups
    .map((group): AnnotatedChild | null => {
      const groupLive = thinkingLive && group.id === liveThoughtGroupId;
      // Single-line mode folds completed Thought blocks away entirely — only
      // the live "Thinking" indicator (governed by groupLive) survives.
      if (minimalActivity && group.thinking && !groupLive) return null;
      if (hiddenNarrationIds.has(group.id)) {
        return { kind: "assistant", id: group.id, node: null, createdAt: group.createdAt, sortAt: group.lastActivityAt };
      }
      if (group.thinking) {
        const node = (
          <ThoughtBlock
            key={group.id}
            display={thinkingDisplay}
            previewText={group.text}
            defaultExpanded={toolsExpandOverride ?? false}
            // Minimal names the live thought without spelling it out; the
            // block leaves the turn as soon as the next step lands.
            autoExpandWhileLive={!compactActivity && !minimalActivity}
            live={groupLive}
            holdOpen={
              isLatestTurn && toolsExpandOverride !== false && group.id === liveThoughtGroupId
            }
            durationMs={thoughtDurationMs(group.createdAt, group.lastActivityAt)}
          >
            {/* `streaming` while the thought is live is what splits the
                committed prefix off the tail. Rendering a growing reasoning
                buffer as one non-streaming block re-parsed the whole thing per
                delta, so a long thought cost O(n²) before it ever collapsed.
                Unpaced: reasoning arrives in bursts the typewriter cadence
                would trail by seconds, then snap when the thought ends. */}
            <StreamingMarkdown
              text={group.text}
              streaming={groupLive}
              paced={false}
              workspace={workspace}
              onOpenFile={onOpenFile}
            />
          </ThoughtBlock>
        );
        return {
          kind: "assistant",
          id: group.id,
          node,
          ...(compactActivity
            ? {
                activityMember: {
                  kind: "thought" as const,
                  id: group.id,
                  node,
                  live: groupLive
                }
              }
            : {}),
          createdAt: group.createdAt,
          sortAt: group.lastActivityAt
        };
      }
      if (group.error) {
        if (!assistantGroupHasVisibleChat(group)) return null;
        return {
          kind: "assistant",
          id: group.id,
          node: <LogBlock key={group.id} text={group.text} tone="error" />,
          createdAt: group.createdAt,
          sortAt: group.lastActivityAt
        };
      }
      if (!assistantGroupHasVisibleChat(group)) return null;
      const node = (
        <ChatBubble
          key={group.id}
          kind="assistant"
          rawMarkdown={group.text}
        >
          <StreamingMarkdown
            text={group.text}
            streaming={group.streaming}
            restoring={restoringTranscript}
            revealKey={session ? `${session.id}:${group.createdAt}:${group.id}` : null}
            workspace={workspace}
            onOpenFile={onOpenFile}
          />
        </ChatBubble>
      );
      return { kind: "assistant", id: group.id, node, createdAt: group.createdAt, sortAt: group.lastActivityAt };
    })
    .filter((child): child is AnnotatedChild => child !== null);
  if (todo) {
    assistantChildren.push({
      kind: "assistant",
      id: `todo-${item.id}`,
      node: <TodoCard key={`todo-${item.id}`} list={todo} running={isStreamingTurn} />,
      createdAt: todo.updatedAt,
      sortAt: todo.updatedAt
    });
  }
  const visibleToolItems = useMemo(
    () =>
      item.toolItems
        .map((tItem) => visibleTurnToolItem(tItem, hiddenToolIds))
        .filter((tItem): tItem is TurnToolItem => tItem !== null),
    [item.toolItems, hiddenToolIds]
  );
  const isTurnLiveTicking = isStreamingTurn && !isPausedOnUserInput;
  const toolChildren: AnnotatedChild[] = visibleToolItems
    .map((tItem) => {
        if (isAgentToolName(tItem.tool.name)) {
          return {
            kind: "tool" as const,
            id: tItem.tool.id,
            createdAt: tItem.tool.createdAt,
            sortAt: tItem.tool.createdAt,
            agentTools: [tItem.tool],
            node: null
          };
        }
        return {
          kind: "tool" as const,
          id: tItem.tool.id,
          createdAt: tItem.tool.createdAt,
          sortAt: tItem.tool.createdAt,
          runTools: [tItem.tool, ...(tItem.children ?? [])],
          node: (
            <ToolCallRow
              tool={tItem.tool}
              childTools={tItem.children}
              defaultExpanded={toolsExpanded}
              workspaceCwd={workspace?.path ?? null}
              agentCodename={codenameForTool(tItem.tool, agentCodenames)}
              onOpenFile={onOpenFile}
              onOpenAgent={onOpenAgent}
            />
          )
        };
    });
  const steerChildren: AnnotatedChild[] = item.steerEvents.map((event) => ({
    kind: "assistant",
    id: `steer-${event.id}`,
    createdAt: event.createdAt,
    sortAt: event.createdAt,
    sortPriority: -1,
    node: (
      <SessionConversationUserMessage
        key={event.id}
        event={event}
        attachments={parseUserMessageAttachments({ kind: "user-message", event })}
      />
    )
  }));
  const sortedChildren = [...assistantChildren, ...toolChildren, ...steerChildren]
    .sort((a, b) => {
      const cmp = a.sortAt.localeCompare(b.sortAt);
      if (cmp !== 0) return cmp;
      // A steer precedes the response it influenced when both share a
      // timestamp. Otherwise assistant narration precedes a tool that starts
      // in the same millisecond.
      const priorityCmp =
        (a.sortPriority ?? (a.kind === "assistant" ? 0 : 1)) -
        (b.sortPriority ?? (b.kind === "assistant" ? 0 : 1));
      return priorityCmp;
    });
  const coalescedChildren: AnnotatedChild[] = [];
  for (const child of sortedChildren) {
    // A launch keeps its own row at every verbosity, Compact included. Folding
    // routine ones into the activity summary buried the single row that names
    // the delegated work, carries the codename and emblem, and opens the
    // subagent's pane — a whole child agent read as "started an agent" behind
    // a collapsed line, indistinguishable from a file read.
    const last = coalescedChildren[coalescedChildren.length - 1];
    if (child.agentTools && last?.agentTools) {
      last.agentTools.push(...child.agentTools);
      continue;
    }
    coalescedChildren.push(
      child.agentTools ? { ...child, agentTools: [...child.agentTools] } : child
    );
  }
  const renderActivityGroup = ({ tools, members }: ActivityRun): ReactNode => (
    <ToolCallGroupBubble
      group={buildToolCallGroup(tools)}
      activityMembers={members}
      disclosureId={`session-${session?.id ?? "unknown"}-${item.id}`}
      compact={compactToolSummaries}
      minimal={minimalActivity}
      defaultExpanded={!minimalActivity && toolsExpanded}
      defaultToolsExpanded={toolRowsExpanded}
      follow={follow}
      workspaceCwd={workspace?.path ?? null}
      agentCodenames={agentCodenames}
      onOpenFile={onOpenFile}
      onOpenAgent={onOpenAgent}
    />
  );
  const bodySource = (compactActivity
    ? foldActivityRunsToSummaries(coalescedChildren, renderActivityGroup)
    : foldToolRunsToSummaries(coalescedChildren, (tools) =>
        renderActivityGroup({ tools, members: [] })
      )
  ).filter((child) => child.agentTools || child.node !== null);
  const bodyChildren: TurnBodyChild[] = bodySource.map((child) => {
    if (child.agentTools) {
      const first = child.agentTools[0];
      const id = first ? `agent-list-${first.id}` : child.id;
      return {
        kind: "tool" as const,
        id,
        node: (
          <AgentLaunchList
            key={id}
            tools={child.agentTools}
            defaultExpanded={toolRowsExpanded}
            workspaceCwd={workspace?.path ?? null}
            agentCodenames={agentCodenames}
            onOpenFile={onOpenFile}
            onOpenAgent={onOpenAgent}
          />
        )
      };
    }
    return { kind: child.kind, id: child.id, node: child.node };
  });
  const {
    visibleItems: mountedBodyChildren,
    hiddenEarlierCount: hiddenEarlierBodyCount,
    showEarlier: showEarlierBody
  } = useStableTailWindow(bodyChildren, {
    initialCount: TURN_BODY_WINDOW,
    pageSize: TURN_BODY_WINDOW_STEP,
    follow,
    getId: (child) => child.id
  });
  const earliestCreatedAt = [...assistantChildren, ...toolChildren]
    .map((c) => c.createdAt)
    .filter((t) => t.length > 0)
    .sort()[0];
  // Hover footer content: the turn's assistant prose for Copy, and a fork
  // handler when the provider supports forking a resumed conversation. Read
  // from the same groups the chat renders, not from the raw events: those
  // still carry the extended-thinking blocks and stderr log lines, and their
  // answer text is one row per streamed fragment, so "Copy reply" pasted the
  // model's reasoning ahead of a reply chopped at every delta boundary.
  const turnMarkdown = visibleAssistantGroups
    .filter((group) => !group.thinking && !group.error)
    .map((group) => group.text.trim())
    .filter((text) => text.length > 0)
    .join("\n\n");
  // Mirror `fork_session`'s gate (orchestration.rs): a mid-turn fork would copy
  // a partial transcript, so the backend refuses "running" and "waiting". The
  // footer only hides itself on the *latest* live turn, so without this every
  // earlier turn — and every turn of a waiting session — offered a button whose
  // only possible outcome was an error toast.
  // Files this turn wrote, folded one row per path. Derived from the same tool
  // input the activity rows read, so the card cannot disagree with them.
  const turnChanges = useMemo(
    () => collectTurnFileChanges(visibleToolItems),
    [visibleToolItems]
  );
  const changesCard =
    turnChanges.length > 0 ? (
      <TurnChangesCard
        changes={turnChanges}
        workspaceCwd={workspace?.path ?? null}
        defaultExpanded={defaultTurnChangesExpanded ?? true}
        {...(onOpenDiff ? { onOpenDiff } : {})}
        {...(onOpenFile ? { onOpenFile } : {})}
        {...(onOpenReview ? { onOpenReview } : {})}
      />
    ) : null;
  const forkable =
    session !== null &&
    FORK_CAPABLE_PROVIDERS.has(session.provider) &&
    session.state !== "running" &&
    session.state !== "waiting" &&
    onForkSession !== undefined;
  // The turn's own id is synthetic; the checkpoint was anchored to the user
  // message this turn answers, which is the render item just above it.
  const revertUserMessageId =
    priorItem?.kind === "user-message" ? priorItem.event.id : undefined;
  const revertCheckpointId = revertUserMessageId
    ? revertCheckpointIds?.get(revertUserMessageId)
    : undefined;
  const revertUnavailableReason =
    revertUserMessageId && !revertCheckpointId
      ? revertCheckpointUnavailable?.get(revertUserMessageId)
      : undefined;
  const revert =
    (revertCheckpointId || revertUnavailableReason) &&
    workspace &&
    onReverted &&
    !isTurnLiveTicking ? (
      <TurnRevert
        workspaceId={workspace.id}
        {...(revertCheckpointId ? { checkpointId: revertCheckpointId } : {})}
        {...(revertUnavailableReason ? { unavailableReason: revertUnavailableReason } : {})}
        disabled={session?.state === "running" || session?.state === "waiting"}
        onReverted={onReverted}
      />
    ) : null;
  return (
    <TurnBlock
      key={item.id}
      toolItems={visibleToolItems}
      assistantTimestamps={item.assistantTimestamps}
      {...(Number.isFinite(turnStartedAtMs) ? { turnStartedAtMs } : {})}
      isTurnActive={isTurnLiveTicking}
      toolsExpanded={toolsExpanded}
      onToggleTools={() => setToolsExpandOverride(!toolsExpanded)}
      hasCollapsibleActivity={compactActivity && bodyChildren.some((child) => child.kind === "tool")}
      hideWorkingWhenCollapsed={minimalActivity}
      body={mountedBodyChildren}
      hiddenEarlierBodyCount={hiddenEarlierBodyCount}
      onShowEarlierBody={showEarlierBody}
      {...(earliestCreatedAt ? { headerTimestampIso: earliestCreatedAt } : {})}
      {...(turnMarkdown ? { turnMarkdown } : {})}
      {...(changesCard ? { changes: changesCard } : {})}
      {...(forkable && session ? { onFork: () => void onForkSession?.(session.id) } : {})}
      {...(revert ? { revert } : {})}
    />
  );
}

// Memoized so a render of the parent SessionConversation (e.g. a composer
// keystroke, or a delta for a different turn) only re-renders turns whose props
// actually changed. Default shallow comparison is sufficient because every prop
// is referentially stable across a parent render that didn't touch this turn.
export const SessionConversationTurn = memo(SessionConversationTurnInner);

/**
 * Preserve the typed prompt while marking skills and linking URLs. Resolve
 * links first so URL path segments never render as skill invocations.
 */
function markUserMessage(text: string): ReactNode {
  const segments = splitLinkSegments(text);
  if (!segments) return markSkillTokens(text);
  return segments.map((segment, index) =>
    segment.link ? (
      <WebLink key={index} href={segment.text}>
        {segment.text}
      </WebLink>
    ) : (
      <Fragment key={index}>{markSkillTokens(segment.text)}</Fragment>
    )
  );
}

function markSkillTokens(text: string): ReactNode {
  const segments = splitSkillTokens(text, () => true);
  if (!segments) return text;
  return segments.map((segment, index) =>
    segment.skill ? (
      <span key={index} className="skill-token" title={`Skill: ${segment.text}`}>
        {segment.text}
      </span>
    ) : (
      segment.text
    )
  );
}

/** The session an incoming `user.message` was written by, not typed in. */
interface UserMessageOrigin {
  sessionId: string;
  label: string;
}

/**
 * Reads the `origin` block Rust writes onto a message that arrived from
 * another session. Either identifier missing (or blank) means there is no
 * chat to name or open, so the message renders as an ordinary user bubble
 * rather than a header pointing nowhere.
 */
function readMessageOrigin(payload: unknown): UserMessageOrigin | null {
  if (typeof payload !== "object" || payload === null) return null;
  const origin = (payload as { origin?: unknown }).origin;
  if (typeof origin !== "object" || origin === null) return null;
  const { sessionId, label } = origin as { sessionId?: unknown; label?: unknown };
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) return null;
  if (typeof label !== "string" || label.trim().length === 0) return null;
  return { sessionId, label: label.trim() };
}

/** True when Rust marked this `user.message` as delivered mid-turn (steer)
 *  rather than queued for the next turn. */
function readMessageIsSteer(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  return (payload as { delivery?: unknown }).delivery === "steer";
}

/** User-message row from a render item (not a turn). */
export function SessionConversationUserMessage({
  event,
  attachments,
  isTurnAnchor = false,
  onOpenSession
}: {
  event: Extract<RenderItem, { kind: "user-message" }>["event"];
  attachments: UserMessageAttachment[];
  isTurnAnchor?: boolean;
  /** Focuses another session's chat, for a message that came from one. Absent
   *  on hosts with no way to reach a second chat, which leaves the header's
   *  label as plain text. */
  onOpenSession?: (sessionId: string) => void;
}): JSX.Element {
  const origin = readMessageOrigin(event.payload);
  const isSteer = readMessageIsSteer(event.payload);
  let displayMessage = event.message;
  for (const a of attachments) {
    displayMessage = displayMessage.split(`@${a.filePath}`).join("");
  }
  displayMessage = displayMessage.replace(/[ \t]+(?=\n|$)/g, "").trim();
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  return (
    <div
      className="user-message-group"
      {...(isTurnAnchor ? { "data-turn-anchor": "true" } : {})}
      {...(origin ? { role: "article", "aria-label": "Message from another chat" } : {})}
    >
      {origin || isSteer ? (
        <div className="user-message-origin">
          {origin ? (
            <>
              From{" "}
              {onOpenSession ? (
                <button
                  type="button"
                  className="user-message-origin-open"
                  aria-label={`Open chat: ${origin.label}`}
                  title={`Open chat: ${origin.label}`}
                  onClick={() => onOpenSession(origin.sessionId)}
                >
                  {origin.label}
                </button>
              ) : (
                <span className="user-message-origin-label" title={origin.label}>
                  {origin.label}
                </span>
              )}
            </>
          ) : null}
          {origin && isSteer ? " · " : null}
          {isSteer ? (
            <span className="user-message-steer">
              <CornerDownRight size={12} aria-hidden="true" />
              Sent during the turn
            </span>
          ) : null}
        </div>
      ) : null}
      {attachments.length > 0 ? (
        <div className="user-message-attachments" aria-label="Attachments">
          {attachments.map((a) => {
            const filename = a.filePath.split("/").pop() || a.filePath;
            if (isSupportedImageMime(a.mimeType)) {
              const url = attachmentProtocolUrl(a.filePath);
              return (
                <figure
                  key={a.filePath}
                  className="user-message-attachment-preview"
                  title={a.filePath}
                >
                  <button
                    type="button"
                    className="attachment-open-button"
                    aria-label={`View image: ${filename}`}
                    onClick={() => setLightboxSrc(url)}
                  >
                    <img
                      className="user-message-attachment-image"
                      src={url}
                      alt={`Attached image: ${filename}`}
                    />
                  </button>
                </figure>
              );
            }
            return (
              <span
                key={a.filePath}
                className="user-message-attachment-chip"
                title={a.filePath}
              >
                {filename}
              </span>
            );
          })}
        </div>
      ) : null}
      {displayMessage ? (
        <ChatBubble
          key={event.id}
          kind="user"
          rawMarkdown={displayMessage}
        >
          {/* The raw text (with the slashes) stays in rawMarkdown so copy
              keeps the real message. */}
          <p>{markUserMessage(displayMessage)}</p>
        </ChatBubble>
      ) : null}
      <ImageLightbox src={lightboxSrc} alt="Attached image" onClose={() => setLightboxSrc(null)} />
    </div>
  );
}
