import type { SessionSummary, TimelineEvent } from "../../shared/types.js";
import { decodeTimelineEvent } from "./canonicalTimeline.js";
import { compactionNoticeFor, type CompactionNotice } from "./compaction.js";
import {
  mergeMultitaskNotice,
  multitaskNoticeFor,
  type MultitaskNotice
} from "./multitask.js";
import {
  projectMoveNoticeFor,
  type ProjectMoveNotice
} from "./projectMove.js";
import {
  providerSwitchNoticeFor,
  type ProviderSwitchNotice
} from "./providerSwitch.js";
import {
  isAgentToolName,
  type ConversationItem,
  type ToolCall
} from "./toolCalls.js";
import { foldTurnToolItems, type TurnToolItem } from "./turnToolItems.js";

export type RenderItem =
  | { kind: "user-message"; event: TimelineEvent }
  | { kind: "compaction"; id: string; notice: CompactionNotice }
  | { kind: "project-move"; id: string; notice: ProjectMoveNotice }
  | { kind: "provider-switch"; id: string; notice: ProviderSwitchNotice }
  | { kind: "session-note"; id: string; message: string }
  | {
      kind: "turn";
      id: string;
      assistantEvents: TimelineEvent[];
      steerEvents: TimelineEvent[];
      toolItems: TurnToolItem[];
      assistantTimestamps: number[];
      /** Multitasks dispatched during this turn, collected above the composer. */
      multitasks: MultitaskNotice[];
    };

/**
 * Merge conversation events and tool calls into one chronological stream.
 * Presentation groups are built only after prose has been interleaved.
 */
export function foldConversationItems(
  conversationEvents: readonly TimelineEvent[],
  toolCalls: readonly ToolCall[]
): ConversationItem[] {
  const items: ConversationItem[] = [
    ...conversationEvents.map((event) => ({ kind: "message" as const, event })),
    ...toolCalls.map((tool) => ({ kind: "tool" as const, tool }))
  ];
  const itemTime = (item: ConversationItem): string =>
    item.kind === "message" ? item.event.createdAt : item.tool.createdAt;
  return items.sort((a, b) => itemTime(a).localeCompare(itemTime(b)));
}

/**
 * Second-level fold: group user→assistant→tools into a single "turn" so the
 * chat has Codex-style rhythm. A turn's opening user message stays standalone.
 * steering messages remain chronological children of that active turn. The
 * assistant and tool work folds under one "Worked for Xs" chip header.
 *
 * If `session` has a `prompt` but no `user.message` event has landed yet
 * (the brief window between launch and the first delta), synthesize a
 * placeholder user-message item from `session.prompt` so the user sees
 * what they typed.
 *
 */
export function foldRenderItems(
  conversationItems: readonly ConversationItem[],
  session: SessionSummary | null | undefined
): RenderItem[] {
  const out: RenderItem[] = [];
  // Preserve the historical fallback keys from the old transport-level tool
  // grouping. These keys survive bounded-history windows with no user row,
  // including a run whose first tool is later filtered as a late child.
  const fallbackToolRuns = new Map<string, readonly ToolCall[]>();
  let fallbackRun: ToolCall[] = [];
  const finishFallbackRun = (): void => {
    const first = fallbackRun[0];
    if (!first) return;
    const run = fallbackRun;
    for (const tool of run) fallbackToolRuns.set(tool.id, run);
    fallbackRun = [];
  };
  for (const item of conversationItems) {
    if (item.kind === "tool" && !isAgentToolName(item.tool.name)) {
      fallbackRun.push(item.tool);
    } else {
      finishFallbackRun();
      if (item.kind === "tool") fallbackToolRuns.set(item.tool.id, [item.tool]);
    }
  }
  finishFallbackRun();
  let pending:
    | {
        assistantEvents: TimelineEvent[];
        steerEvents: TimelineEvent[];
        toolItems: TurnToolItem[];
        multitasks: MultitaskNotice[];
        firstId: string | null;
      }
    | null = null;
  let activeTurnId: string | null = null;
  // A subagent's child rows belong to the launch that spawned them, not to
  // whatever turn they land in. A backgrounded subagent keeps emitting rows
  // after the user's follow-up has already opened the next turn, and there they
  // find no launch to nest under: they rendered as top-level activity of a turn
  // that never asked for them, and their writes were counted into that turn's
  // Changed-files card. A child whose launch is in the same turn still nests
  // under it (`attachAgentChildren`); one that outlives its turn is left to the
  // subagent's own activity pane. A launch that fell out of the transcript
  // window is not in this set, so its orphans keep rendering rather than
  // vanishing.
  const agentLaunchIds = new Set<string>();
  for (const item of conversationItems) {
    const tools = item.kind === "tool" ? [item.tool] : [];
    for (const tool of tools) {
      if (isAgentToolName(tool.name)) agentLaunchIds.add(tool.toolUseId);
    }
  }
  let turnLaunchIds = new Set<string>();
  const registerLaunch = (tool: ToolCall): void => {
    if (isAgentToolName(tool.name)) turnLaunchIds.add(tool.toolUseId);
  };
  const belongsToThisTurn = (tool: ToolCall): boolean => {
    const parent = tool.parentToolUseId;
    if (typeof parent !== "string" || parent === tool.toolUseId) return true;
    return !agentLaunchIds.has(parent) || turnLaunchIds.has(parent);
  };
  const fallbackToolId = (tool: ToolCall): string => {
    const run = fallbackToolRuns.get(tool.id) ?? [tool];
    const visibleRun = run.filter(belongsToThisTurn);
    const first = visibleRun[0] ?? tool;
    return visibleRun.length > 1 ? `tcg-${first.id}` : first.id;
  };
  // A multitask notice stays associated with the turn it was dispatched from.
  // It is not a seam, so dispatching one mid-turn never splits that turn's
  // block in two. SessionConversation lifts the visible row above the composer.
  //
  // The dispatch and the finish are two rows about one multitask, and they can
  // be a whole turn apart. The second one updates the row the first one
  // opened, so the chat carries one row per
  // multitask rather than a start marker and an unrelated end marker.
  const pushMultitask = (event: TimelineEvent): void => {
    const notice = multitaskNoticeFor(event);
    const key = notice.childSessionId;
    if (key) {
      const lists = [
        ...(pending ? [pending.multitasks] : []),
        ...out.flatMap((candidate) => (candidate.kind === "turn" ? [candidate.multitasks] : []))
      ];
      for (const list of lists) {
        const at = list.findIndex((candidate) => candidate.childSessionId === key);
        const existing = at >= 0 ? list[at] : undefined;
        if (existing) {
          list[at] = mergeMultitaskNotice(existing, notice);
          return;
        }
      }
    }
    if (!pending) {
      pending = {
        assistantEvents: [],
        steerEvents: [],
        toolItems: [],
        multitasks: [],
        firstId: activeTurnId
      };
    }
    pending.multitasks.push(notice);
  };
  // A note about the session itself is not a seam: it says what Argmax did to
  // the chat, not that the agent changed hands. Ending the turn on it would
  // split one answer across two blocks, so a note that lands inside a turn
  // waits for that turn to close and then follows it.
  let deferredNotes: RenderItem[] = [];
  const pushSessionNote = (event: TimelineEvent): void => {
    const item: RenderItem = {
      kind: "session-note",
      id: `session-note-${event.id}`,
      message: event.message
    };
    if (pending) deferredNotes.push(item);
    else out.push(item);
  };
  const flush = (): void => {
    turnLaunchIds = new Set();
    if (!pending) return;
    if (
      pending.assistantEvents.length > 0 ||
      pending.steerEvents.length > 0 ||
      pending.toolItems.length > 0 ||
      pending.multitasks.length > 0
    ) {
      out.push({
        kind: "turn",
        id: pending.firstId ?? `turn-${out.length}`,
        assistantEvents: pending.assistantEvents,
        steerEvents: pending.steerEvents,
        toolItems: foldTurnToolItems(pending.toolItems),
        assistantTimestamps: pending.assistantEvents.map((e) => Date.parse(e.createdAt)),
        multitasks: pending.multitasks
      });
    }
    pending = null;
    out.push(...deferredNotes);
    deferredNotes = [];
  };
  // Compaction is a seam in the conversation, so it ends the turn it lands in
  // and the work that follows opens a fresh one. The provider emits a start and
  // an end row. They collapse into one item so the marker settles in place
  // instead of stacking two dividers.
  //
  // Claude repeats the start row: `system/status status:"compacting"` is a
  // heartbeat every 30s for as long as the compaction runs, so a five-minute
  // one arrives as ten identical rows. They are one seam, and the marker keeps
  // the first row's id so the key and the `turn-after-` anchor stay put while
  // the heartbeat ticks.
  const pushCompaction = (event: TimelineEvent): string => {
    const notice = compactionNoticeFor(event);
    const last = out[out.length - 1];
    if (last?.kind === "compaction" && last.notice.running) {
      out[out.length - 1] = { ...last, notice };
      return last.id;
    }
    const id = `compaction-${event.id}`;
    out.push({ kind: "compaction", id, notice });
    return id;
  };
  for (const item of conversationItems) {
    const canonical = item.kind === "message" ? decodeTimelineEvent(item.event) : null;
    if (item.kind === "message" && canonical?.kind === "multitask") {
      pushMultitask(item.event);
      continue;
    }
    if (
      item.kind === "message" &&
      canonical?.kind === "lifecycle" &&
      canonical.name === "note"
    ) {
      pushSessionNote(item.event);
      continue;
    }
    if (
      item.kind === "message" &&
      canonical?.kind === "lifecycle" &&
      canonical.name === "moved"
    ) {
      flush();
      const id = `project-move-${item.event.id}`;
      out.push({ kind: "project-move", id, notice: projectMoveNoticeFor(item.event) });
      activeTurnId = `turn-after-${id}`;
      continue;
    }
    // A provider handoff is the same shape of seam as a compaction: it ends the
    // turn it lands in, and the follow-up that triggered it opens a fresh one
    // under the new agent. Unlike compaction it is a single row, so there is no
    // start/end pair to collapse.
    if (
      item.kind === "message" &&
      canonical?.kind === "lifecycle" &&
      canonical.name === "provider-changed"
    ) {
      flush();
      const id = `provider-switch-${item.event.id}`;
      out.push({ kind: "provider-switch", id, notice: providerSwitchNoticeFor(item.event) });
      activeTurnId = `turn-after-${id}`;
      continue;
    }
    if (
      item.kind === "message" &&
      canonical?.kind === "lifecycle" &&
      (canonical.name === "compacting" || canonical.name === "compacted")
    ) {
      flush();
      // Re-anchor to the seam: the work after a compaction is a new turn, and
      // leaving the previous user message as the anchor would hand both turns
      // the same React key. The collapsed marker keeps the start event's id, so
      // this stays stable across the start/end pair and across delta eviction.
      activeTurnId = `turn-after-${pushCompaction(item.event)}`;
      continue;
    }
    if (
      item.kind === "message" &&
      canonical?.kind === "message" &&
      canonical.role === "user"
    ) {
      // Steering is guidance inside the active native turn. Keep it in the
      // same render item so the TurnBlock, live state, timer, and tool
      // ownership survive while the user bubble remains in chronological
      // transcript order.
      if (canonical.delivery === "steer") {
        if (!pending) {
          pending = {
            assistantEvents: [],
            steerEvents: [],
            toolItems: [],
            multitasks: [],
            firstId: activeTurnId
          };
        }
        pending.steerEvents.push(item.event);
        continue;
      }
      flush();
      out.push({ kind: "user-message", event: item.event });
      activeTurnId = `turn-${item.event.id}`;
      continue;
    }
    if (item.kind === "tool") registerLaunch(item.tool);
    if (item.kind === "tool" && !belongsToThisTurn(item.tool)) continue;
    if (!pending) {
      pending = {
        assistantEvents: [],
        steerEvents: [],
        toolItems: [],
        multitasks: [],
        firstId: activeTurnId
      };
    }
    if (item.kind === "message") {
      pending.assistantEvents.push(item.event);
      if (!pending.firstId) pending.firstId = `turn-${item.event.id}`;
    } else if (item.kind === "tool") {
      pending.toolItems.push({ kind: "tool", tool: item.tool });
      if (!pending.firstId) {
        pending.firstId = `turn-${fallbackToolId(item.tool)}`;
      }
    }
  }
  flush();
  // Bridge the brief window between launch and the first user.message event
  // arriving over dashboard:delta. `session.prompt` is set synchronously on
  // launch, so we can show it as a placeholder bubble until the real event
  // lands and naturally takes its place.
  const hasUserMessage = out.some((item) => item.kind === "user-message");
  const prompt = session?.prompt?.trim();
  if (!hasUserMessage && session && prompt) {
    out.unshift({
      kind: "user-message",
      event: {
        id: `synth-user-${session.id}`,
        sessionId: session.id,
        type: "user.message",
        message: session.prompt,
        payload: { source: "composer" },
        createdAt: session.startedAt
      }
    });
  }
  return out;
}
