import type { SessionSummary } from "../../shared/types.js";

/**
 * The one session a workspace shows as its chat.
 *
 * A workspace holds exactly one session by design (CONTEXT.md), but the schema
 * permits more and reality produces them — two peers launched into the same
 * checkout, an import landing beside a live chat. When that happens every
 * reader has to name the *same* one, or a row describes one chat and opens
 * another. That one is the most recently active, ties broken the way the
 * dashboard query breaks them (`last_activity_at DESC, id DESC`).
 *
 * Stated rather than read off the array: `snapshot.sessions` does arrive
 * newest-first and stays that way through `mergeDashboardDelta`, but taking
 * that on trust is what let a `new Map(...)` (last writer wins, so the oldest)
 * and a `.find(...)` (first wins, so the newest) sit in the same app picking
 * opposite sessions for the same row.
 *
 * Mirrored in `ios/Argmax/Sources/Chats/ChatSections.swift`.
 */
function isLaterChat(candidate: SessionSummary, held: SessionSummary): boolean {
  if (candidate.lastActivityAt !== held.lastActivityAt) {
    return candidate.lastActivityAt > held.lastActivityAt;
  }
  return candidate.id > held.id;
}

/** Every workspace's chat, keyed by workspace id. */
export function chatSessionByWorkspace(
  sessions: readonly SessionSummary[]
): Map<string, SessionSummary> {
  const byWorkspace = new Map<string, SessionSummary>();
  for (const session of sessions) {
    const held = byWorkspace.get(session.workspaceId);
    if (!held || isLaterChat(session, held)) {
      byWorkspace.set(session.workspaceId, session);
    }
  }
  return byWorkspace;
}

/** One workspace's chat, for the callers that only need the one. */
export function chatSessionFor(
  sessions: readonly SessionSummary[],
  workspaceId: string
): SessionSummary | null {
  let chat: SessionSummary | null = null;
  for (const session of sessions) {
    if (session.workspaceId !== workspaceId) continue;
    if (!chat || isLaterChat(session, chat)) chat = session;
  }
  return chat;
}
