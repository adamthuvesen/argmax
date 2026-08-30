import type { SessionSummary, TimelineEvent } from "../../shared/types.js";
import { compactionNoticeFor, isCompactionEvent, type CompactionNotice } from "./compaction.js";
import {
  isProviderSwitchEvent,
  providerSwitchNoticeFor,
  type ProviderSwitchNotice
} from "./providerSwitch.js";
import type { TurnToolItem } from "./toolCalls.js";
import {
  buildToolCallGroup,
  isAgentToolName,
  type ConversationItem,
  type ToolCall
} from "./toolCalls.js";

export type RenderItem =
  | { kind: "user-message"; event: TimelineEvent }
  | { kind: "compaction"; id: string; notice: CompactionNotice }
  | { kind: "provider-switch"; id: string; notice: ProviderSwitchNotice }
  | {
      kind: "turn";
      id: string;
      assistantEvents: TimelineEvent[];
      toolItems: TurnToolItem[];
      assistantTimestamps: number[];
    };

/**
 * First-level fold: merge conversation events + tool calls into a single
 * time-ordered list, then collapse adjacent tool runs (≥ 2 tools with no
 * intervening message) into a `tool-group`. The 75 ms parallel window for
 * grouping is handled inside `buildToolCallGroup`.
 */
export function foldConversationItems(
  conversationEvents: readonly TimelineEvent[],
  toolCalls: readonly ToolCall[]
): ConversationItem[] {
  // Pre-fold items hold only message/tool kinds; `tool-group` is built by the
  // folding pass below, so `itemTime` only handles concrete event/tool rows.
  type PreFoldItem = Extract<ConversationItem, { kind: "message" } | { kind: "tool" }>;
  const items: PreFoldItem[] = [
    ...conversationEvents.map((event) => ({ kind: "message" as const, event })),
    ...toolCalls.map((tool) => ({ kind: "tool" as const, tool }))
  ];
  const itemTime = (item: PreFoldItem): string =>
    item.kind === "message" ? item.event.createdAt : item.tool.createdAt;
  const sorted: ConversationItem[] = items.sort((a, b) => itemTime(a).localeCompare(itemTime(b)));
  const folded: ConversationItem[] = [];
  let run: ToolCall[] = [];

  const flushRun = (): void => {
    if (run.length === 0) return;
    if (run.length === 1) {
      const [tool] = run;
      if (tool) folded.push({ kind: "tool", tool });
    } else {
      folded.push({ kind: "tool-group", group: buildToolCallGroup(run) });
    }
    run = [];
  };

  for (const item of sorted) {
    if (item.kind !== "tool") {
      flushRun();
      folded.push(item);
      continue;
    }
    if (isAgentToolName(item.tool.name)) {
      flushRun();
      folded.push(item);
      continue;
    }
    run.push(item.tool);
  }
  flushRun();
  return folded;
}

/**
 * Second-level fold: group user→assistant→tools into a single "turn" so the
 * chat has Codex-style rhythm. User messages stay standalone; everything
 * between two user messages folds under one "Worked for Xs" chip header.
 *
 * If `session` has a `prompt` but no `user.message` event has landed yet
 * (the brief window between launch and the first delta), synthesize a
 * placeholder user-message item from `session.prompt` so the user sees
 * what they typed.
 *
 * @param foldTurnToolItems Callback that groups same-turn adjacent tool
 *   items the same way `foldConversationItems` does for cross-turn ones;
 *   passed in to avoid a cycle with TurnBlock.
 */
export function foldRenderItems(
  conversationItems: readonly ConversationItem[],
  session: SessionSummary | null | undefined,
  foldTurnToolItems: (items: TurnToolItem[]) => TurnToolItem[]
): RenderItem[] {
  const out: RenderItem[] = [];
  let pending:
    | { assistantEvents: TimelineEvent[]; toolItems: TurnToolItem[]; firstId: string | null }
    | null = null;
  let activeTurnId: string | null = null;
  const flush = (): void => {
    if (!pending) return;
    if (pending.assistantEvents.length === 0 && pending.toolItems.length === 0) {
      pending = null;
      return;
    }
    out.push({
      kind: "turn",
      id: pending.firstId ?? `turn-${out.length}`,
      assistantEvents: pending.assistantEvents,
      toolItems: foldTurnToolItems(pending.toolItems),
      assistantTimestamps: pending.assistantEvents.map((e) => Date.parse(e.createdAt))
    });
    pending = null;
  };
  // Compaction is a seam in the conversation, so it ends the turn it lands in
  // and the work that follows opens a fresh one. The provider emits a start and
  // an end row. They collapse into one item so the marker settles in place
  // instead of stacking two dividers.
  const pushCompaction = (event: TimelineEvent): string => {
    const notice = compactionNoticeFor(event);
    const last = out[out.length - 1];
    if (!notice.running && last?.kind === "compaction" && last.notice.running) {
      out[out.length - 1] = { ...last, notice };
      return last.id;
    }
    const id = `compaction-${event.id}`;
    out.push({ kind: "compaction", id, notice });
    return id;
  };
  for (const item of conversationItems) {
    // A provider handoff is the same shape of seam as a compaction: it ends the
    // turn it lands in, and the follow-up that triggered it opens a fresh one
    // under the new agent. Unlike compaction it is a single row, so there is no
    // start/end pair to collapse.
    if (item.kind === "message" && isProviderSwitchEvent(item.event)) {
      flush();
      const id = `provider-switch-${item.event.id}`;
      out.push({ kind: "provider-switch", id, notice: providerSwitchNoticeFor(item.event) });
      activeTurnId = `turn-after-${id}`;
      continue;
    }
    if (item.kind === "message" && isCompactionEvent(item.event)) {
      flush();
      // Re-anchor to the seam: the work after a compaction is a new turn, and
      // leaving the previous user message as the anchor would hand both turns
      // the same React key. The collapsed marker keeps the start event's id, so
      // this stays stable across the start/end pair and across delta eviction.
      activeTurnId = `turn-after-${pushCompaction(item.event)}`;
      continue;
    }
    if (item.kind === "message" && item.event.type === "user.message") {
      flush();
      out.push({ kind: "user-message", event: item.event });
      activeTurnId = `turn-${item.event.id}`;
      continue;
    }
    if (!pending) pending = { assistantEvents: [], toolItems: [], firstId: activeTurnId };
    if (item.kind === "message") {
      pending.assistantEvents.push(item.event);
      if (!pending.firstId) pending.firstId = `turn-${item.event.id}`;
    } else if (item.kind === "tool") {
      pending.toolItems.push({ kind: "tool", tool: item.tool });
      if (!pending.firstId) pending.firstId = `turn-${item.tool.id}`;
    } else {
      pending.toolItems.push({ kind: "tool-group", group: item.group });
      if (!pending.firstId) pending.firstId = `turn-${item.group.id}`;
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
