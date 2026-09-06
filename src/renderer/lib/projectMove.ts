import type { TimelineEvent } from "../../shared/types.js";
import { decodeTimelineEvent } from "./canonicalTimeline.js";

export interface ProjectMoveNotice {
  from: string | null;
  to: string;
  checkoutMode: "shared" | "worktree" | "attached" | null;
  sourceArchiveState: string | null;
}

export interface SessionMoveDestination {
  sourceSessionId: string;
  destinationSessionId: string;
  destinationWorkspaceId: string;
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
  // A checkout move stays in one project, so the project name says nothing:
  // name the directory the chat actually moved into instead, and drop the
  // "from" side that would otherwise read "Argmax → Argmax".
  if (canonical.checkoutMode === "attached") {
    const directory = canonical.destinationPath?.split("/").filter(Boolean).at(-1);
    return {
      from: null,
      to: directory ?? canonical.destinationPath ?? event.message,
      checkoutMode: canonical.checkoutMode,
      sourceArchiveState: canonical.sourceArchiveState
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
