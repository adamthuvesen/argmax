import { useBridgeQuery } from "../data/useBridgeQuery.js";
import { objectValue, stringValue } from "../../shared/typeGuards.js";

/**
 * Before-turn checkpoints for a workspace, keyed by the user-message event
 * each one was taken for.
 *
 * The backend records that event id as the checkpoint's `turnBoundary`, which
 * is what lets a turn in the transcript find its own checkpoint instead of the
 * user picking from a list of identically named rows.
 */
export function useTurnCheckpoints(
  workspaceId: string | undefined,
  sessionState: string | undefined,
  workspaceActivityAt: string | undefined,
): {
  checkpointIds: ReadonlyMap<string, string>;
  refresh: () => void;
} {
  // Re-read when a turn settles, which is when a new before-turn checkpoint
  // has appeared and the previous turn became revertable, and when the
  // workspace moves, which is when a turn in another chat on the same checkout
  // took one. Kept across chat switches: the key says when it is stale.
  const { data, refetch } = useBridgeQuery<ReadonlyMap<string, string>>({
    key: ["checkpoints.list", workspaceId, sessionState, workspaceActivityAt],
    enabled: workspaceId !== undefined,
    read: (api) =>
      workspaceId === undefined
        ? undefined
        : api.checkpoints?.list({ workspaceId, limit: 200 }).then(checkpointsByTurn),
    retain: true,
  });

  // A checkout with no readable checkpoints simply offers no revert. The
  // failure is not kept, so the next mount reads again.
  return {
    checkpointIds: workspaceId === undefined ? NO_CHECKPOINTS : (data ?? NO_CHECKPOINTS),
    refresh: () => void refetch(),
  };
}

const NO_CHECKPOINTS: ReadonlyMap<string, string> = new Map();

function checkpointsByTurn(
  rows: readonly { id: string; turnBoundary?: string | null; worktreeTree?: string | null }[],
): ReadonlyMap<string, string> {
  const byTurn = new Map<string, string>();
  // Newest first, so the first row for a boundary wins if a turn was ever
  // checkpointed twice.
  for (const row of rows) {
    if (row.turnBoundary && row.worktreeTree && !byTurn.has(row.turnBoundary)) {
      byTurn.set(row.turnBoundary, row.id);
    }
  }
  return byTurn;
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
