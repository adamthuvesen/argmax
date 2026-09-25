import type { TimelineEvent } from "../../shared/types.js";
import { parseQuestionsFromToolInput } from "./questions.js";
import { buildSessionToolCalls } from "./sessionConversationModel.js";
import { isAskUserQuestionToolName } from "./turnInteractiveCards.js";

/**
 * What a multitask is waiting on, in one line, from its own transcript: the
 * question its agent asked and stopped for. Null while nothing is open — an
 * answered ask is a completed tool, and the row goes back to its state word.
 *
 * The newest open ask wins. A chat that asked twice without an answer is one
 * the person will open anyway; the row only has to say why.
 */
export function multitaskPendingQuestion(events: readonly TimelineEvent[]): string | null {
  const asks = buildSessionToolCalls(events).filter(
    (tool) => isAskUserQuestionToolName(tool.name) && tool.status === "running"
  );
  for (let index = asks.length - 1; index >= 0; index -= 1) {
    const questions = parseQuestionsFromToolInput(asks[index]);
    const first = questions?.[0]?.question.trim();
    if (first) return first;
  }
  return null;
}
