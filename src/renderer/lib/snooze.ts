import type { SessionSummary, WorkspaceSummary } from "../../shared/types.js";

/**
 * The snooze shelf. A snooze is display metadata: `snoozedUntil` hides a row in
 * a collapsed shelf until that instant, and changes nothing about the chat's
 * state, its session, or what the gh poller does with its pull request.
 *
 * Membership is derived here from the clock, never stored, so there is no
 * backend timer to restore after a restart or sleep. The sidebar arms one
 * `setTimeout` for the earliest expiry (`nextSnoozeExpiry`) and re-derives.
 */

/** Attention values a snooze never hides: the agent is blocked on the person. */
const URGENT_ATTENTION = new Set(["approval-needed", "question-asked"]);

/** Epoch ms a workspace stays snoozed until, or null when it is not snoozed now. */
export function activeSnoozeUntil(workspace: WorkspaceSummary, nowMs: number): number | null {
  if (!workspace.snoozedUntil) return null;
  const until = Date.parse(workspace.snoozedUntil);
  return Number.isFinite(until) && until > nowMs ? until : null;
}

/**
 * Workspaces with a pending approval or an unanswered question. These stay in
 * their normal section while snoozed: hiding the one thing an agent is waiting
 * on would stall it with nobody looking.
 */
export function workspacesAwaitingAnswer(sessions: readonly SessionSummary[]): Set<string> {
  const waiting = new Set<string>();
  for (const session of sessions) {
    if (URGENT_ATTENTION.has(session.attention)) waiting.add(session.workspaceId);
  }
  return waiting;
}

export interface SnoozeShelf {
  /** Workspaces to lift out of their normal section and show on the shelf. */
  shelfIds: ReadonlySet<string>;
  /** Earliest instant any current snooze ends, or null when none are active. */
  nextExpiryAt: number | null;
}

/**
 * Archived rows are never shelved. Pinned rows keep their place (a pin is an explicit "keep this in sight"), and
 * so do rows an agent is waiting on. Everything else with a live snooze goes to
 * the shelf.
 */
export function computeSnoozeShelf(
  workspaces: readonly WorkspaceSummary[],
  sessions: readonly SessionSummary[],
  nowMs: number
): SnoozeShelf {
  const waiting = workspacesAwaitingAnswer(sessions);
  const shelfIds = new Set<string>();
  let nextExpiryAt: number | null = null;
  for (const workspace of workspaces) {
    // An archived chat belongs in the Archived section whatever its snooze says.
    // The poller archives a merged PR's chat without asking, so a snoozed row
    // that was archived would otherwise be in neither section.
    if (workspace.state === "archived") continue;
    const until = activeSnoozeUntil(workspace, nowMs);
    if (until === null) continue;
    nextExpiryAt = nextExpiryAt === null ? until : Math.min(nextExpiryAt, until);
    if (workspace.pinned || waiting.has(workspace.id)) continue;
    shelfIds.add(workspace.id);
  }
  return { shelfIds, nextExpiryAt };
}

export interface SnoozeChoice {
  key: "hour" | "tomorrow" | "week";
  label: string;
  /** RFC 3339 instant to send as `until`. */
  until: string;
}

/** Local-time 9:00 on the day `daysAhead` days after `from`. */
function morning(from: Date, daysAhead: number): Date {
  const next = new Date(from);
  next.setDate(next.getDate() + daysAhead);
  next.setHours(9, 0, 0, 0);
  return next;
}

/** The three offers on the row menu, all strictly in the future. */
export function snoozeChoices(from: Date): SnoozeChoice[] {
  return [
    { key: "hour", label: "Snooze for 1 hour", until: new Date(from.getTime() + 3_600_000).toISOString() },
    { key: "tomorrow", label: "Snooze until tomorrow", until: morning(from, 1).toISOString() },
    { key: "week", label: "Snooze for a week", until: morning(from, 7).toISOString() }
  ];
}

/** `setTimeout` stores its delay in 32 bits; a longer wait fires immediately. */
export const MAX_TIMER_MS = 2_147_483_647;

/** Delay for the single timer that re-derives the shelf at the next expiry. */
export function snoozeTimerDelay(nextExpiryAt: number, nowMs: number): number {
  return Math.min(MAX_TIMER_MS, Math.max(0, nextExpiryAt - nowMs) + 1);
}
