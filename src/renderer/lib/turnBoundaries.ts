import type { TimelineEvent } from "../../shared/types.js";

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
 *     the delta and the completion, so the delta is real pre-tool narration
 *     (Cursor emits this), not a duplicate — keep it.
 *   - `user.message` → "user": the next turn started without this one ever
 *     completing — keep the delta.
 *
 * The two sweeps feed different event sets (the merge sees everything, the
 * view model only conversation-visible events plus tool boundaries), but the
 * boundary classification and the superseded predicate must stay identical or
 * chat rendering and snapshot pruning drift apart.
 */
export type TurnBoundary = "completed" | "tool" | "user";

/** Fold one event (scanning right-to-left) into the session's next-boundary state. */
export function advanceTurnBoundary(
  previous: TurnBoundary | undefined,
  event: TimelineEvent
): TurnBoundary | undefined {
  if (event.type === "message.completed") return "completed";
  if (event.type === "command.started") return previous === "completed" ? "tool" : previous;
  if (event.type === "user.message") return "user";
  return previous;
}

/**
 * A non-thinking answer delta whose next boundary is a completion is a
 * duplicate of the final answer. Thinking deltas are never superseded — they
 * are the only record of the model's reasoning step and stay visible after
 * the final answer arrives.
 */
export function isSupersededAnswerDelta(
  event: TimelineEvent,
  nextBoundary: TurnBoundary | undefined
): boolean {
  return (
    event.type === "message.delta" &&
    event.payload?.["thinking"] !== true &&
    nextBoundary === "completed"
  );
}
