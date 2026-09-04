import type { TimelineEvent } from "../../shared/types.js";
import type { ChangedFileSummary } from "../../shared/types.js";
import { decodeTimelineEvent } from "./canonicalTimeline.js";
import { editedFilePaths } from "./fileChange.js";
import { extractToolInput } from "./toolCalls.js";

/**
 * Repo-relative paths the agent wrote during the newest turn.
 *
 * Git has no notion of a turn, so the scope comes from the transcript: every
 * file-writing tool call after the newest `user.message`. That is the exact
 * set the agent chose to edit, which is what "last turn" means to a reader,
 * unlike an mtime sweep, which also picks up build output.
 *
 * Providers report tool paths absolute (Claude) or repo-relative (Codex), so
 * `matchesLastTurn` compares by path suffix rather than requiring the caller
 * to know the workspace root.
 *
 * `events` arrives newest-first, matching the dashboard merge order.
 */
export function lastTurnEditedPaths(events: readonly TimelineEvent[]): string[] {
  const paths = new Set<string>();
  for (const event of events) {
    const decoded = decodeTimelineEvent(event);
    if (decoded.kind === "message" && decoded.role === "user") break;
    if (decoded.kind !== "tool" || decoded.phase !== "started") continue;
    for (const path of editedFilePaths(decoded.name, extractToolInput(decoded.raw.payload))) {
      paths.add(path);
    }
  }
  return [...paths];
}

/** Filter a changed-file list down to the paths a turn actually wrote. */
export function filterToLastTurn(
  files: readonly ChangedFileSummary[],
  lastTurnPaths: readonly string[]
): ChangedFileSummary[] {
  if (lastTurnPaths.length === 0) return [];
  return files.filter((file) =>
    lastTurnPaths.some((path) => path === file.path || path.endsWith(`/${file.path}`))
  );
}
