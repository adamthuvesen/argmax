import type { EventType, TimelineEvent } from "../../shared/types.js";
import { decodeTimelineEvent } from "./canonicalTimeline.js";

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
  const canonical = decodeTimelineEvent(event);
  return canonical.kind === "lifecycle" && canonical.name === "moved";
}

export function projectMoveNoticeFor(event: TimelineEvent): ProjectMoveNotice {
  const canonical = decodeTimelineEvent(event);
  if (canonical.kind !== "lifecycle" || canonical.name !== "moved") {
    return {
      from: null,
      to: event.message,
      checkoutMode: null,
      sourceArchiveState: null
    };
  }
  return {
    from: canonical.sourceProjectName,
    to: canonical.destinationProjectName ?? event.message,
    checkoutMode: canonical.checkoutMode,
    sourceArchiveState: canonical.sourceArchiveState
  };
}

export function sessionMoveDestination(event: TimelineEvent): SessionMoveDestination | null {
  const canonical = decodeTimelineEvent(event);
  if (
    canonical.kind !== "lifecycle" ||
    canonical.name !== "moved" ||
    canonical.direction === null ||
    !canonical.sourceSessionId ||
    !canonical.destinationSessionId ||
    !canonical.destinationWorkspaceId
  ) {
    return null;
  }
  return {
    sourceSessionId: canonical.sourceSessionId,
    destinationSessionId: canonical.destinationSessionId,
    destinationWorkspaceId: canonical.destinationWorkspaceId
  };
}
