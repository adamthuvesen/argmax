import type { PendingMessage, SessionSummary } from "../../shared/types.js";

/**
 * Leave enough room for the steered continuation and its first tool result.
 * Codex can compact between those responses when the current prompt is already
 * near the window limit, losing the just-emitted acknowledgement while keeping
 * the steer. The resumed model can then answer the same guidance again.
 */
const CODEX_STEER_MAX_CONTEXT_RATIO = 0.85;

export function hasSteeringContextHeadroom(
  session: Pick<SessionSummary, "provider" | "contextTokens" | "contextWindow">
): boolean {
  if (session.provider !== "codex") return true;
  if (!session.contextWindow || session.contextWindow <= 0) return true;
  return session.contextTokens / session.contextWindow < CODEX_STEER_MAX_CONTEXT_RATIO;
}

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
    | "state"
    | "provider"
    | "modelId"
    | "reasoningEffort"
    | "agentMode"
    | "contextTokens"
    | "contextWindow"
  >,
  entry: Pick<PendingMessage, "modelId" | "reasoningEffort" | "agentMode">
): boolean {
  return (
    session.state === "running" &&
    (session.provider === "codex" || session.provider === "claude") &&
    hasSteeringContextHeadroom(session) &&
    (entry.modelId === undefined || entry.modelId === session.modelId) &&
    (entry.reasoningEffort === undefined || entry.reasoningEffort === session.reasoningEffort) &&
    entry.agentMode === (session.agentMode ?? "auto")
  );
}
