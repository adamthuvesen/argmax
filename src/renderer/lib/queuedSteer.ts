import type { PendingMessage, SessionSummary } from "../../shared/types.js";

/**
 * Whether a queued follow-up can be steered into the running turn instead of
 * interrupting it.
 *
 * Only Claude and Codex accept text mid-turn, and only for the settings the
 * turn is already running under: a row queued against another model, effort,
 * or agent mode would arrive as a different chat's message. Two composers ask
 * this — the desktop's lane and the phone shell's card, through the `composer`
 * message — so the rule lives here rather than in either of them.
 */
export function canSteerQueuedMessage(
  session: Pick<
    SessionSummary,
    "state" | "provider" | "modelId" | "reasoningEffort" | "agentMode"
  >,
  entry: Pick<PendingMessage, "modelId" | "reasoningEffort" | "agentMode">
): boolean {
  return (
    session.state === "running" &&
    (session.provider === "codex" || session.provider === "claude") &&
    (entry.modelId === undefined || entry.modelId === session.modelId) &&
    (entry.reasoningEffort === undefined || entry.reasoningEffort === session.reasoningEffort) &&
    entry.agentMode === (session.agentMode ?? "auto")
  );
}
