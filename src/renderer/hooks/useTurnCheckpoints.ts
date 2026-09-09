import { useCallback, useEffect, useState } from "react";
import { objectValue, stringValue } from "../../shared/typeGuards.js";

/**
 * Before-turn checkpoints for a workspace, keyed by the user-message event
 * each one was taken for.
 *
 * The backend records that event id as the checkpoint's `turnBoundary`, which
 * is what lets a turn in the transcript find its own checkpoint instead of the
 * user picking from a list of identically named rows.
 */
export function useTurnCheckpoints(workspaceId: string | undefined, sessionState: string | undefined): {
  checkpointIds: ReadonlyMap<string, string>;
  refresh: () => void;
} {
  const [checkpointIds, setCheckpointIds] = useState<ReadonlyMap<string, string>>(() => new Map());

  const load = useCallback(async (): Promise<void> => {
    const api = window.argmax?.checkpoints;
    if (!api || !workspaceId) {
      setCheckpointIds(new Map());
      return;
    }
    try {
      const rows = await api.list({ workspaceId, limit: 200 });
      const next = new Map<string, string>();
      // Newest first, so the first row for a boundary wins if a turn was ever
      // checkpointed twice.
      for (const row of rows) {
        if (row.turnBoundary && row.worktreeTree && !next.has(row.turnBoundary)) {
          next.set(row.turnBoundary, row.id);
        }
      }
      setCheckpointIds(next);
    } catch {
      // A checkout with no readable checkpoints simply offers no revert.
      setCheckpointIds(new Map());
    }
  }, [workspaceId]);

  // Re-read when a turn settles: that is when a new before-turn checkpoint
  // has appeared and the previous turn became revertable.
  useEffect(() => {
    void load();
  }, [load, sessionState]);

  return { checkpointIds, refresh: () => void load() };
}

/** Why Revert is unavailable for a turn whose before-turn checkpoint failed. */
export function readCheckpointUnavailableReason(payload: unknown): string | null {
  const object = objectValue(payload);
  if (!object || object.checkpointUnavailable !== true) {
    return null;
  }
  const reason = stringValue(object.checkpointUnavailableReason);
  return reason
    ? `No checkpoint was saved before this turn. ${reason}`
    : "No checkpoint was saved before this turn.";
}
