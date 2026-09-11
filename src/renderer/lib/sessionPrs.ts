import type { GhPrRecord } from "../../shared/types.js";

/** Refreshes in flight, keyed by session. */
const pending = new Map<string, Promise<GhPrRecord[]>>();

/**
 * `prs:refresh` for one session, collapsed across callers.
 *
 * The refresh shells out to `gh` over the network — measured 2026-09-10 at
 * 460–915 ms per call — and two independent surfaces ask for it the moment a
 * session opens: the chat actions menu wants the rows, and the workspace card
 * wants the workspace publish the refresh performs on its way out. Left alone
 * they fire the same `gh pr view` twice in the same tick on every switch.
 *
 * `null` when the host has no gh channel at all.
 */
export function refreshSessionPrs(sessionId: string): Promise<GhPrRecord[]> | null {
  const inFlight = pending.get(sessionId);
  if (inFlight) return inFlight;
  // Surfaces that reach Argmax without the gh channel (the phone companion)
  // keep whatever rows they already have rather than being handed an empty list.
  const refreshPrs = window.argmax?.prs?.refresh;
  if (!refreshPrs) return null;
  const refresh = refreshPrs({ sessionId }).finally(() => {
    pending.delete(sessionId);
  });
  pending.set(sessionId, refresh);
  return refresh;
}
