import type { EventType, TimelineEvent } from "../../shared/types.js";

export const SESSION_MOVED: EventType = "session.moved";

export interface ProjectMoveNotice {
  from: string | null;
  to: string;
  checkoutMode: "shared" | "worktree" | null;
  sourceArchiveState: string | null;
}

export interface SessionMoveDestination {
  sourceSessionId: string;
  destinationSessionId: string;
  destinationWorkspaceId: string;
}

export function isProjectMoveEvent(event: TimelineEvent): boolean {
  return event.type === SESSION_MOVED;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function projectMoveNoticeFor(event: TimelineEvent): ProjectMoveNotice {
  const checkoutMode = nonEmptyString(event.payload.checkoutMode);
  return {
    from: nonEmptyString(event.payload.sourceProjectName),
    to: nonEmptyString(event.payload.destinationProjectName) ?? event.message,
    checkoutMode:
      checkoutMode === "shared" || checkoutMode === "worktree" ? checkoutMode : null,
    sourceArchiveState: nonEmptyString(event.payload.sourceArchiveState)
  };
}

export function sessionMoveDestination(event: TimelineEvent): SessionMoveDestination | null {
  if (!isProjectMoveEvent(event) || event.payload.direction !== "destination") return null;
  const sourceSessionId = nonEmptyString(event.payload.sourceSessionId);
  const destinationSessionId = nonEmptyString(event.payload.destinationSessionId);
  const destinationWorkspaceId = nonEmptyString(event.payload.destinationWorkspaceId);
  if (!sourceSessionId || !destinationSessionId || !destinationWorkspaceId) return null;
  return { sourceSessionId, destinationSessionId, destinationWorkspaceId };
}
