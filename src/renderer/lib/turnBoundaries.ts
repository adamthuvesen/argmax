import type { TimelineEvent } from "../../shared/types.js";
import { decodeTimelineEvent } from "./canonicalTimeline.js";

/**
 * Sub-agent prose that is hidden from the parent chat: Claude child rows carry
 * `parent_tool_use_id` (trace-imported Codex/Cursor rows reuse the same
 * marker), and live Codex child messages are `agent_message` payloads with
 * thread linkage. Both turn sweeps below must exclude exactly these rows —
 * a hidden child completion must never act as a turn boundary that prunes the
 * parent's still-streaming answer.
 */
export function isSubAgentProseEcho(event: TimelineEvent): boolean {
  const canonical = decodeTimelineEvent(event);
  return canonical.kind === "message" && canonical.childProse;
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
 *   - A child `command.started` with `parent_tool_use_id` does not change the
 *     boundary. Subagent tools can interleave while the parent streams one
 *     message, so they do not separate parent narration from its completion.
 *   - `command.started` downgrades "completed" → "tool": a tool ran between
 *     the deltas and the completion, so they may be real pre-tool narration
 *     (Cursor emits this). Keep them unless the later completed text already
 *     starts with them, which means they are just an early prefix of the same
 *     final message. That is judged on the whole run of answer deltas under
 *     the boundary, never one token at a time: Cursor's completion repeats the
 *     turn's narration, so its first token alone ("Pull") matched and was
 *     dropped while the rest of the word ("ing up…") stayed on screen.
 *   - `user.message` → "user": the next turn started without this one ever
 *     completing — keep the delta.
 *
 * The two sweeps feed different event sets (the merge sees everything, the
 * view model only conversation-visible events plus tool boundaries), but both
 * run `supersededAnswerDeltaIds` so chat rendering and snapshot pruning never
 * drift apart.
 */
type TurnBoundary =
  | { kind: "completed"; completedText: string }
  | { kind: "tool"; completedText: string | null }
  | { kind: "user" };

/** Fold one event (scanning right-to-left) into the session's next-boundary state. */
function advanceTurnBoundary(
  previous: TurnBoundary | undefined,
  event: TimelineEvent
): TurnBoundary | undefined {
  const canonical = decodeTimelineEvent(event);
  if (
    canonical.kind === "message" &&
    canonical.role === "assistant" &&
    canonical.phase === "completed"
  ) {
    return { kind: "completed", completedText: event.message };
  }
  if (canonical.kind === "tool" && canonical.phase === "started") {
    if (canonical.parentToolUseId !== null) return previous;
    return previous?.kind === "completed"
      ? { kind: "tool", completedText: previous.completedText }
      : previous;
  }
  if (
    canonical.kind === "message" &&
    canonical.role === "user" &&
    canonical.delivery !== "steer"
  ) {
    return { kind: "user" };
  }
  return previous;
}

function isCompletedPrefixDuplicate(runText: string, completedText: string): boolean {
  const run = runText.trim();
  if (run.length < 3) return false;
  return completedText.trim().startsWith(run);
}

/**
 * Ids of the answer deltas the turn's final answer supersedes. `ascending` is
 * swept right-to-left; `skip` drops rows that are neither prune candidates nor
 * boundaries. Deltas under a "completed" boundary go at once. Deltas under a
 * "tool" boundary collect into a run that is settled as a whole when the
 * boundary changes: the run goes only if the completed text starts with it.
 * Thinking deltas are never superseded — they are the only record of the
 * model's reasoning step and stay visible after the final answer arrives.
 */
export function supersededAnswerDeltaIds(
  ascending: readonly TimelineEvent[],
  skip: (event: TimelineEvent) => boolean = () => false
): Set<string> {
  const nextBoundary = new Map<string, TurnBoundary>();
  const runs = new Map<string, { completedText: string; ids: string[]; fragments: string[] }>();
  const superseded = new Set<string>();
  const settleRun = (sessionId: string): void => {
    const run = runs.get(sessionId);
    if (!run) return;
    runs.delete(sessionId);
    // Collected right-to-left, so the fragments read backwards.
    if (isCompletedPrefixDuplicate(run.fragments.reverse().join(""), run.completedText)) {
      for (const id of run.ids) superseded.add(id);
    }
  };
  for (let index = ascending.length - 1; index >= 0; index -= 1) {
    const event = ascending[index];
    if (!event || skip(event)) continue;
    const canonical = decodeTimelineEvent(event);
    if (canonical.kind === "message" && canonical.phase === "delta") {
      if (canonical.content !== "answer") continue;
      const boundary = nextBoundary.get(event.sessionId);
      if (boundary?.kind === "completed") {
        superseded.add(event.id);
      } else if (boundary?.kind === "tool" && boundary.completedText !== null) {
        const run = runs.get(event.sessionId) ?? { completedText: boundary.completedText, ids: [], fragments: [] };
        run.ids.push(event.id);
        run.fragments.push(event.message);
        runs.set(event.sessionId, run);
      }
      continue;
    }
    const previous = nextBoundary.get(event.sessionId);
    const boundary = advanceTurnBoundary(previous, event);
    if (boundary === previous) continue;
    settleRun(event.sessionId);
    if (boundary !== undefined) nextBoundary.set(event.sessionId, boundary);
  }
  for (const sessionId of [...runs.keys()]) settleRun(sessionId);
  return superseded;
}
