import type { SessionSummary } from "../../shared/types.js";

/**
 * Window within which stopping a newly launched session is considered an "early stop"
 * (e.g. launched in the wrong repository, with the wrong prompt, or by mistake):
 * the pane returns to the composer with the prompt and target preserved, and
 * the workspace is archived so the cancelled chat does not linger in the sidebar.
 */
export const EARLY_STOP_WINDOW_MS = 10_000;

/**
 * Determines whether a session was stopped within the early-stop window from launch.
 * Returns true if the session was launched within `windowMs` (defaults to 10 seconds).
 */
export function isEarlySessionStop(
  session: Pick<SessionSummary, "startedAt"> | null | undefined,
  now = Date.now(),
  windowMs = EARLY_STOP_WINDOW_MS
): boolean {
  if (!session?.startedAt) return false;
  const startedAtMs = Date.parse(session.startedAt);
  if (Number.isNaN(startedAtMs)) return false;
  const elapsedMs = now - startedAtMs;
  return elapsedMs >= -60_000 && elapsedMs <= windowMs;
}
