import type { TimelineEvent } from "../../shared/types.js";

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Sub-agent prose that is hidden from the parent chat: Claude child rows carry
 * `parent_tool_use_id` (trace-imported Codex/Cursor rows reuse the same
 * marker), and live Codex child messages are `agent_message` payloads with
 * thread linkage. Both turn sweeps below must exclude exactly these rows —
 * a hidden child completion must never act as a turn boundary that prunes the
 * parent's still-streaming answer.
 */
export function isSubAgentProseEcho(event: TimelineEvent): boolean {
  if (event.type !== "message.delta" && event.type !== "message.completed") return false;
  const parentToolUseId = event.payload.parent_tool_use_id;
  if (typeof parentToolUseId === "string" && parentToolUseId.length > 0) return true;
  const item = objectValue(event.payload.item);
  const isCodexAgentMessage = event.payload.item_type === "agent_message" ||
    item?.type === "agent_message";
  if (!isCodexAgentMessage) return false;
  if (stringValue(event.payload.thread_id) !== null || stringValue(event.payload.sender_thread_id) !== null) {
    return true;
  }
  return stringValue(item?.thread_id) !== null || stringValue(item?.sender_thread_id) !== null;
}

/**
 * Shared rule for when a streaming `message.delta` is superseded by the turn's
 * final answer. Both the dashboard merge (snapshot.ts pruneSupersededDeltas)
 * and the chat view model (sessionConversationModel.ts buildConversationEvents)
 * sweep events right-to-left tracking, per session, the closest turn boundary
 * AFTER the current position:
 *
 *   - `message.completed` → "completed": the turn finished; earlier answer
 *     deltas of that turn are duplicates of the final text.
 *   - `command.started` downgrades "completed" → "tool": a tool ran between
 *     the delta and the completion, so the delta may be real pre-tool narration
 *     (Cursor emits this). Keep it unless the later completed text already
 *     starts with that delta, which means the delta is just an early prefix of
 *     the same final message.
 *   - `user.message` → "user": the next turn started without this one ever
 *     completing — keep the delta.
 *
 * The two sweeps feed different event sets (the merge sees everything, the
 * view model only conversation-visible events plus tool boundaries), but the
 * boundary classification and the superseded predicate must stay identical or
 * chat rendering and snapshot pruning drift apart.
 */
export type TurnBoundary =
  | { kind: "completed"; completedText: string }
  | { kind: "tool"; completedText: string | null }
  | { kind: "user" };

/** Fold one event (scanning right-to-left) into the session's next-boundary state. */
export function advanceTurnBoundary(
  previous: TurnBoundary | undefined,
  event: TimelineEvent
): TurnBoundary | undefined {
  if (event.type === "message.completed") {
    return { kind: "completed", completedText: event.message };
  }
  if (event.type === "command.started") {
    return previous?.kind === "completed"
      ? { kind: "tool", completedText: previous.completedText }
      : previous;
  }
  if (event.type === "user.message") return { kind: "user" };
  return previous;
}

function isCompletedPrefixDuplicate(event: TimelineEvent, completedText: string | null): boolean {
  if (completedText === null) return false;
  const delta = event.message.trim();
  if (delta.length < 3) return false;
  return completedText.trim().startsWith(delta);
}

/**
 * A non-thinking answer delta whose next boundary is a completion is a
 * duplicate of the final answer. If a tool appears between the delta and the
 * completion, only prune when the completed answer already starts with that
 * delta. Thinking deltas are never superseded — they are the only record of
 * the model's reasoning step and stay visible after the final answer arrives.
 */
export function isSupersededAnswerDelta(
  event: TimelineEvent,
  nextBoundary: TurnBoundary | undefined
): boolean {
  return (
    event.type === "message.delta" &&
    event.payload?.["thinking"] !== true &&
    (nextBoundary?.kind === "completed" ||
      (nextBoundary?.kind === "tool" && isCompletedPrefixDuplicate(event, nextBoundary.completedText)))
  );
}
