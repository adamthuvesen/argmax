import type { TimelineEvent } from "../../shared/types.js";
import type { ChangedFileSummary } from "../../shared/types.js";
import { editedFilePaths } from "./fileChange.js";
import { extractToolInput, extractToolName } from "./toolCalls.js";

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
    if (event.type === "user.message") break;
    if (event.type !== "command.started") continue;
    for (const path of editedFilePaths(extractToolName(event.payload), extractToolInput(event.payload))) {
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
