import type { SessionSummary, WorkspaceSummary } from "../../shared/types.js";

/**
 * The labelled id block a user pastes into another agent's prompt or a bug
 * report: Argmax session id, the provider's own conversation id (what a CLI's
 * resume or send-message takes), the workspace id, and its path. One line
 * each, so a reader can pick the id they need without knowing the schema.
 */
export function formatSessionIds(session: SessionSummary | null, workspace: WorkspaceSummary | null): string {
  return [
    session ? `session   ${session.id}` : null,
    session?.providerConversationId ? `provider  ${session.providerConversationId}` : null,
    workspace ? `workspace ${workspace.id}` : null,
    workspace ? `path      ${workspace.path}` : null
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
