import { MessageSquare } from "lucide-react";
import type { JSX } from "react";
import { lookUpChat, openChat, useChatDirectory } from "../state/chatDirectory.js";

/**
 * A chat named in the transcript, drawn as a chip that opens it: the source a
 * prompt attached, or one an answer cited. Prompts and answers hold the chat
 * as the same `[title](argmax://chat/<id>)` link the composer writes, so a
 * chip here and a chip in the composer are one thing. A chat the app no longer
 * has keeps its title and says it is gone, rather than offering to open nothing.
 */
export function ChatSourceChip({
  sessionId,
  title
}: {
  sessionId: string;
  /** The title the link carried: the chat's name when it was attached. */
  title: string;
}): JSX.Element {
  // Subscribed so a chat that arrives or is renamed redraws the chip.
  useChatDirectory();
  const entry = lookUpChat(sessionId);
  if (!entry) {
    return (
      <span
        className="chat-source-chip"
        data-status="unresolved"
        title="This chat is no longer available"
      >
        <MessageSquare size={12} aria-hidden="true" />
        <span className="chat-source-chip-label">{title} (unavailable)</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      className="chat-source-chip"
      data-status="resolved"
      title={`Open chat: ${entry.title}`}
      aria-label={`Open chat: ${entry.title}`}
      onClick={() => openChat(sessionId)}
    >
      <MessageSquare size={12} aria-hidden="true" />
      <span className="chat-source-chip-label">{entry.title}</span>
    </button>
  );
}
