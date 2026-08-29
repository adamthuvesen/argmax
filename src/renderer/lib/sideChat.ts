import type { TimelineEvent } from "../../shared/types.js";

/** How much of the source conversation travels into a side chat: the newest
 *  exchanges, each capped, so the seed stays a prompt and not a transcript
 *  dump. The side chat is a fresh session with no other memory of the source,
 *  so this block is its entire grounding. */
const CONTEXT_EVENT_LIMIT = 12;
const CONTEXT_CHARS_PER_EVENT = 700;

function clip(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= CONTEXT_CHARS_PER_EVENT) return trimmed;
  return `${trimmed.slice(0, CONTEXT_CHARS_PER_EVENT)}…`;
}

function quotedExcerptWithContext(excerpt: string, events: readonly TimelineEvent[]): string {
  const exchanges = events
    .filter(
      (event) =>
        (event.type === "user.message" || event.type === "message.completed") &&
        event.message.trim().length > 0
    )
    .slice(-CONTEXT_EVENT_LIMIT)
    .map((event) => `${event.type === "user.message" ? "User" : "Assistant"}: ${clip(event.message)}`);
  const quote = excerpt
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  const context =
    exchanges.length > 0
      ? `Recent context from that session:\n\n${exchanges.join("\n\n")}\n\n`
      : "";
  return context + `The excerpt I selected:\n\n${quote}\n\n`;
}

/**
 * First message of a side chat opened from a transcript selection: recent
 * context from the source session, the quoted excerpt, and an opening
 * instruction. `events` is the source session's conversation events in
 * ascending order (`buildConversationEvents` output).
 */
export function buildSideChatSeed(excerpt: string, events: readonly TimelineEvent[]): string {
  return (
    "This is a side chat about an excerpt from another agent session.\n\n" +
    quotedExcerptWithContext(excerpt, events) +
    "Give me your read on this excerpt, then answer my follow-up questions."
  );
}

/**
 * First message of a "More details" popup session: same context block as a
 * side chat, but the opening instruction asks for a focused explanation. The
 * popup stays conversational — follow-up questions ride the same session.
 */
export function buildDetailsSeed(excerpt: string, events: readonly TimelineEvent[]): string {
  return (
    "This is a quick explainer thread about an excerpt from another agent session.\n\n" +
    quotedExcerptWithContext(excerpt, events) +
    "Explain this excerpt in more detail, concisely, using the context above. " +
    "Then answer my follow-up questions."
  );
}
